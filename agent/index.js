const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// --- config ------------------------------------------------------------------
function loadConfig() {
  const argIdx = process.argv.indexOf('--config');
  const explicit = argIdx >= 0 ? process.argv[argIdx + 1] : null;

  // When packaged with pkg, process.execPath is the .exe; otherwise it's node.
  // We want the config next to where the user runs from in both cases.
  const candidates = [
    explicit,
    path.join(process.cwd(), 'config.json'),
    path.join(path.dirname(process.execPath), 'config.json'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      log(`config loaded from ${p}`);
      return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')), cfgPath: p };
    }
  }
  log(`ERROR: no config.json found. Tried: ${candidates.join(', ')}`);
  log(`Copy config.example.json to config.json next to the executable and edit it.`);
  process.exit(1);
}

// --- logging -----------------------------------------------------------------
// Prefer cwd (where user runs the exe), fall back to dir next to the binary.
let logStream = null;
function openLogStream() {
  const tryPaths = [
    path.join(process.cwd(), 'agent.log'),
    path.join(path.dirname(process.execPath), 'agent.log'),
  ];
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) {
        try { fs.renameSync(p, p + '.1'); } catch {}
      }
      const s = fs.createWriteStream(p, { flags: 'a' });
      s.on('error', () => { logStream = null; });
      // verify writability synchronously
      fs.appendFileSync(p, '');
      logStream = s;
      return;
    } catch {}
  }
}
openLogStream();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  if (logStream) logStream.write(line + '\n');
}

// --- UUPC --------------------------------------------------------------------
function resolveUupcUrl(uupcMap, label) {
  let raw = uupcMap[label] ?? uupcMap.default;
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  return raw.replace(/\/$/, '') + '/machine/state';
}

async function triggerWin(uupcMap, targetLabel, timeoutMs) {
  const url = resolveUupcUrl(uupcMap, targetLabel);
  if (!url) {
    throw new Error(`no UUPC mapped for label "${targetLabel}" (and no "default")`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'value=2',
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`UUPC ${res.status}: ${text}`);
    return { url, body: text };
  } finally {
    clearTimeout(t);
  }
}

// --- SSE client --------------------------------------------------------------
async function streamLoop(cfg) {
  let backoff = 1000;
  const maxBackoff = 30000;

  while (true) {
    try {
      log(`connecting to ${cfg.serverUrl}/api/agent/stream`);
      const res = await fetch(`${cfg.serverUrl}/api/agent/stream`, {
        headers: {
          'authorization': `Bearer ${cfg.agentToken}`,
          'accept': 'text/event-stream',
        },
      });
      if (!res.ok) {
        log(`stream HTTP ${res.status}, retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
        continue;
      }
      log('stream connected');
      backoff = 1000;
      await consumeStream(res.body, cfg);
      log('stream ended, reconnecting');
    } catch (err) {
      log(`stream error: ${err.message}, retrying in ${backoff}ms`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}

async function consumeStream(body, cfg) {
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
      if (parsed && parsed.event === 'scan' && parsed.data) {
        handleScanEvent(parsed.data, cfg).catch((e) =>
          log(`scan handler error: ${e.message}`),
        );
      }
    }
  }
}

function parseSseEvent(raw) {
  const out = { event: 'message', data: null, id: null };
  let dataLines = [];
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
    try { out.data = JSON.parse(dataLines.join('\n')); } catch { out.data = null; }
  }
  return out;
}

async function handleScanEvent(ev, cfg) {
  log(`scan event id=${ev.id} slug=${ev.slug} target=${ev.targetLabel} action=${ev.action}`);
  if (ev.action !== 'win') {
    log(`  unsupported action "${ev.action}", skipping`);
    return;
  }
  try {
    const result = await triggerWin(cfg.uupcMap, ev.targetLabel, cfg.uupcTimeoutMs || 3000);
    log(`  UUPC ${result.url} ok: ${result.body.trim()}`);
  } catch (err) {
    log(`  UUPC error: ${err.message}`);
    return; // don't ack failures, let server replay on reconnect
  }
  try {
    const ackRes = await fetch(`${cfg.serverUrl}/api/agent/ack`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${cfg.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ eventId: ev.id }),
    });
    if (!ackRes.ok) log(`  ack HTTP ${ackRes.status}`);
    else log(`  acked`);
  } catch (err) {
    log(`  ack error: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- main --------------------------------------------------------------------
const { cfg } = loadConfig();
if (!cfg.serverUrl || !cfg.agentToken || !cfg.uupcMap) {
  log('ERROR: config must have serverUrl, agentToken, and uupcMap');
  process.exit(1);
}
log(`agent starting; server=${cfg.serverUrl} uupcMap=${JSON.stringify(cfg.uupcMap)}`);
streamLoop(cfg);
