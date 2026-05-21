const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');

// --- paths -------------------------------------------------------------------
// Prefer cwd (where user runs the exe), fall back to next to the binary.
function pickWritableDir() {
  const candidates = [process.cwd(), path.dirname(process.execPath)];
  for (const d of candidates) {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {}
  }
  return process.cwd();
}
const DATA_DIR = pickWritableDir();
const DATA_FILE = path.join(DATA_DIR, 'local-data.json');
const LOG_FILE = path.join(DATA_DIR, 'agent.log');

// --- logging -----------------------------------------------------------------
let logStream = null;
try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.on('error', () => { logStream = null; });
} catch {}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (logStream) try { logStream.write(line + '\n'); } catch {}
}

// --- state -------------------------------------------------------------------
const DEFAULT_DATA = {
  serverUrl: process.env.QR_SERVER_URL || 'https://qr.allescaperoompuzzles.com',
  publicUrl: null,
  agentId: null,
  agentToken: null,
  qrMappings: {}, // slug -> { ip, name, singleUse, cooldownSeconds, createdAt }
  uupcTimeoutMs: 3000,
};

let data;
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      data = { ...DEFAULT_DATA, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
      return;
    } catch (e) {
      log(`WARN: could not parse ${DATA_FILE}: ${e.message}; using defaults`);
    }
  }
  data = { ...DEFAULT_DATA };
}
function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
loadData();

// --- cloud client ------------------------------------------------------------
async function cloudFetch(pathStr, init = {}) {
  const url = data.serverUrl.replace(/\/$/, '') + pathStr;
  const headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  if (data.agentToken && !headers.authorization) {
    headers.authorization = `Bearer ${data.agentToken}`;
  }
  const res = await fetch(url, { ...init, headers });
  return res;
}

async function ensureRegistered() {
  if (data.agentToken) return;
  log(`registering with ${data.serverUrl} ...`);
  const res = await fetch(data.serverUrl.replace(/\/$/, '') + '/api/agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: `local app ${require('os').hostname()}` }),
  });
  if (!res.ok) {
    throw new Error(`register failed: HTTP ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  data.agentId = body.agentId;
  data.agentToken = body.agentToken;
  data.publicUrl = body.publicUrl || data.serverUrl;
  saveData();
  log(`registered: agentId=${body.agentId}`);
}

// --- UUPC trigger ------------------------------------------------------------
async function triggerWin(ip, timeoutMs) {
  let base = ip;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/$/, '');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/machine/state', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'value=2',
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`UUPC ${res.status}: ${text}`);
    return { url: base + '/machine/state', body: text };
  } finally {
    clearTimeout(t);
  }
}

// --- SSE consumer ------------------------------------------------------------
async function streamLoop() {
  let backoff = 1000;
  const maxBackoff = 30000;
  while (true) {
    try {
      const res = await fetch(data.serverUrl.replace(/\/$/, '') + '/api/agent/stream', {
        headers: { authorization: `Bearer ${data.agentToken}`, accept: 'text/event-stream' },
      });
      if (!res.ok) {
        log(`stream HTTP ${res.status}, retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      log('SSE connected');
      backoff = 1000;
      await consumeStream(res.body);
      log('SSE ended, reconnecting');
    } catch (err) {
      log(`SSE error: ${err.message}, retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}

async function consumeStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseSseEvent(rawEvent);
      if (parsed?.event === 'scan' && parsed.data) {
        handleScanEvent(parsed.data).catch((e) => log(`handler error: ${e.message}`));
      }
    }
  }
}

function parseSseEvent(raw) {
  const out = { event: 'message', data: null, id: null };
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') out.event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') out.id = value;
  }
  if (dataLines.length) {
    try { out.data = JSON.parse(dataLines.join('\n')); } catch {}
  }
  return out;
}

async function handleScanEvent(ev) {
  log(`scan event slug=${ev.slug} action=${ev.action}`);
  const mapping = data.qrMappings[ev.slug];
  if (!mapping) {
    log(`  no local mapping for slug ${ev.slug}, skipping`);
    return;
  }
  if (ev.action !== 'win') {
    log(`  unsupported action ${ev.action}`);
    return;
  }
  try {
    const r = await triggerWin(mapping.ip, data.uupcTimeoutMs);
    log(`  UUPC ${r.url} OK: ${r.body.trim()}`);
  } catch (err) {
    log(`  UUPC error: ${err.message}`);
    return; // don't ack on failure
  }
  try {
    await cloudFetch('/api/agent/ack', {
      method: 'POST',
      body: JSON.stringify({ eventId: ev.id }),
    });
  } catch (err) {
    log(`  ack error: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- web UI ------------------------------------------------------------------
const UI_PORT = Number(process.env.PORT || 8765);

function escapeHtml(v) {
  if (v == null) return '';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CSS = `
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 2rem; max-width: 64rem; margin-inline: auto; }
h1 { margin-top: 0; font-weight: 600; letter-spacing: -0.02em; }
a { color: #60a5fa; }
.card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 0.75rem; padding: 1.5rem; margin-bottom: 1rem; }
.row { display: flex; align-items: center; gap: 1rem; }
.qr-row { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; }
.qr-meta { color: #a1a1aa; font-size: 0.875rem; margin-top: 0.25rem; }
.qr-url { font-family: ui-monospace, monospace; font-size: 0.875rem; color: #a1a1aa; word-break: break-all; }
label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; color: #d4d4d8; }
input[type=text], input[type=number] { width: 100%; padding: 0.625rem 0.75rem; background: #0a0a0a; border: 1px solid #3f3f46; color: #fafafa; border-radius: 0.5rem; font-size: 1rem; font-family: inherit; }
input[type=text]:focus, input[type=number]:focus { outline: none; border-color: #60a5fa; }
.form-row { margin-bottom: 1rem; }
.form-row.inline { display: flex; gap: 0.5rem; align-items: center; }
button, .btn { display: inline-block; padding: 0.625rem 1rem; background: #fafafa; color: #0a0a0a; border: 0; border-radius: 0.5rem; font-weight: 500; cursor: pointer; font-size: 1rem; text-decoration: none; font-family: inherit; }
button:hover, .btn:hover { background: #e5e5e5; }
button.danger { background: transparent; color: #f87171; border: 1px solid #3f3f46; }
button.danger:hover { background: #3f1818; }
.btn.secondary { background: transparent; color: #fafafa; border: 1px solid #3f3f46; }
.btn.secondary:hover { background: #2a2a2a; }
.empty { color: #71717a; text-align: center; padding: 2rem; }
.error { color: #f87171; padding: 0.75rem 1rem; background: #3f1818; border-radius: 0.5rem; margin-bottom: 1rem; }
.print { background: white; color: black; min-height: 100vh; }
@media print { body { background: white; color: black; padding: 0; } .no-print { display: none; } }
`;

function layout(title, bodyHtml, { error } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head><body>
<h1><a href="/" style="color:inherit;text-decoration:none">QR → UUPC</a></h1>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
${bodyHtml}
</body></html>`;
}

function homePage(error) {
  const slugs = Object.keys(data.qrMappings).sort((a, b) => data.qrMappings[b].createdAt - data.qrMappings[a].createdAt);
  const list = slugs.length === 0
    ? `<div class="empty">Brak QR kodów. Dodaj pierwszy poniżej.</div>`
    : slugs.map((slug) => {
        const m = data.qrMappings[slug];
        const url = `${data.publicUrl}/s/${slug}`;
        return `<div class="card qr-row">
          <div>
            <div style="font-size:1.125rem;font-weight:500">${escapeHtml(m.name)}</div>
            <div class="qr-meta">UUPC: ${escapeHtml(m.ip)}${m.singleUse ? ' · jednorazowy' : ''}${m.cooldownSeconds ? ` · cooldown ${m.cooldownSeconds}s` : ''}</div>
            <div class="qr-url">${escapeHtml(url)}</div>
          </div>
          <div style="display:flex;gap:0.5rem">
            <a class="btn" href="/qr/${escapeHtml(slug)}/print" target="_blank">Drukuj</a>
            <form method="POST" action="/qr/${escapeHtml(slug)}/delete" onsubmit="return confirm('Usunąć ten QR?')">
              <button class="danger" type="submit">Usuń</button>
            </form>
          </div>
        </div>`;
      }).join('');

  const form = `<div class="card">
    <h2 style="margin-top:0">Nowy QR</h2>
    <form method="POST" action="/qr">
      <div class="form-row">
        <label>Nazwa (np. „Drzwi sejf")</label>
        <input type="text" name="name" required maxlength="200" placeholder="Drzwi sejf">
      </div>
      <div class="form-row">
        <label>IP UUPC w sieci lokalnej</label>
        <input type="text" name="ip" required placeholder="192.168.1.38" value="${escapeHtml(data._lastIp || '')}">
      </div>
      <div class="form-row">
        <label>Cooldown między skanami (sekundy, 0 = brak)</label>
        <input type="number" name="cooldownSeconds" min="0" max="3600" value="2">
      </div>
      <div class="form-row inline">
        <input type="checkbox" name="singleUse" id="su" value="1">
        <label for="su" style="margin:0">Jednorazowy (po pierwszym skanie wygasa)</label>
      </div>
      <button type="submit">Wygeneruj QR</button>
    </form>
  </div>`;

  return layout('QR → UUPC', `${list}${form}`, { error });
}

async function printPage(slug, res) {
  const m = data.qrMappings[slug];
  if (!m) { res.writeHead(404); res.end('not found'); return; }
  const url = `${data.publicUrl}/s/${slug}`;
  const dataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 600 });
  const body = `<div class="print" style="padding:3rem;text-align:center">
    <img src="${dataUrl}" alt="QR" style="width:60vmin;max-width:600px;height:auto">
    <h2 style="margin-top:1rem;font-weight:500">${escapeHtml(m.name)}</h2>
    <p style="font-family:ui-monospace,monospace;font-size:0.875rem;opacity:0.6">${escapeHtml(url)}</p>
    <div class="no-print" style="margin-top:2rem"><button onclick="window.print()">Drukuj</button></div>
  </div>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Print ${escapeHtml(m.name)}</title>
<style>${CSS}</style></head><body>${body}</body></html>`);
}

async function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}

function sendHtml(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

async function handleCreateQr(req, res) {
  const form = await readForm(req);
  const name = (form.name || '').trim();
  const ip = (form.ip || '').trim();
  const cooldownSeconds = Math.max(0, Math.min(3600, parseInt(form.cooldownSeconds, 10) || 0));
  const singleUse = !!form.singleUse;

  if (!name || !ip) {
    sendHtml(res, 400, homePage('Nazwa i IP są wymagane'));
    return;
  }

  try {
    const r = await cloudFetch('/api/qr', {
      method: 'POST',
      body: JSON.stringify({ name, targetLabel: 'default', singleUse, cooldownSeconds }),
    });
    if (!r.ok) {
      let msg = `Serwer zwrócił błąd ${r.status}`;
      try {
        const errBody = await r.json();
        if (errBody?.error) msg = errBody.error;
      } catch {}
      sendHtml(res, r.status, homePage(msg));
      return;
    }
    const created = await r.json();
    data.qrMappings[created.slug] = {
      ip,
      name,
      singleUse,
      cooldownSeconds,
      createdAt: created.createdAt,
    };
    data._lastIp = ip;
    saveData();
    log(`QR created slug=${created.slug} name="${name}" ip=${ip}`);
    redirect(res, '/');
  } catch (err) {
    sendHtml(res, 500, homePage(`Błąd: ${err.message}`));
  }
}

async function handleDeleteQr(req, res, slug) {
  try {
    await cloudFetch(`/api/qr/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  } catch (err) {
    log(`delete cloud error (continuing): ${err.message}`);
  }
  delete data.qrMappings[slug];
  saveData();
  redirect(res, '/');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, 200, homePage());
    if (req.method === 'POST' && url.pathname === '/qr') return await handleCreateQr(req, res);
    if (req.method === 'GET' && /^\/qr\/[^/]+\/print$/.test(url.pathname)) {
      const slug = url.pathname.split('/')[2];
      return await printPage(slug, res);
    }
    if (req.method === 'POST' && /^\/qr\/[^/]+\/delete$/.test(url.pathname)) {
      const slug = url.pathname.split('/')[2];
      return await handleDeleteQr(req, res, slug);
    }
    res.writeHead(404); res.end('not found');
  } catch (err) {
    log(`HTTP error: ${err.message}`);
    res.writeHead(500); res.end('internal error');
  }
});

// --- browser open ------------------------------------------------------------
function openBrowser(url) {
  if (process.env.NO_OPEN_BROWSER) return;
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

// --- main --------------------------------------------------------------------
(async () => {
  log(`qrcodeuupc local app starting; data=${DATA_FILE}`);
  try {
    await ensureRegistered();
  } catch (err) {
    log(`FATAL: ${err.message}`);
    log(`Sprawdź połączenie z ${data.serverUrl} i uruchom ponownie.`);
    process.exit(1);
  }

  server.listen(UI_PORT, '127.0.0.1', () => {
    const url = `http://localhost:${UI_PORT}`;
    log(`UI: ${url}`);
    openBrowser(url);
  });

  streamLoop();
})();
