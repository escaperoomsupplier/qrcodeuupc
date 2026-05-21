import http from 'node:http';
import { db, migrate } from './db.js';
import {
  randomToken, randomSlug, hashToken,
  readJson, getBearer, clientIp, sendJson, sendHtml, escapeHtml,
} from './util.js';

const PORT = Number(process.env.PORT || 3001);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 10;
const HARD_CAP_PER_AGENT = 100;

migrate();

// --- subscribers (in-memory) ------------------------------------------------
/** @type {Map<number, http.ServerResponse>} agent_id -> active SSE response */
const subscribers = new Map();

function ssePush(agentId, ev) {
  const res = subscribers.get(agentId);
  if (!res) return false;
  res.write(`id: ${ev.id}\n`);
  res.write(`event: scan\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
  return true;
}

// --- helpers ----------------------------------------------------------------
function authAgent(req) {
  const token = getBearer(req);
  if (!token) return null;
  const row = db.prepare('SELECT id, token_hash FROM agents WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
  return row;
}

function checkRateLimit(ip) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM qr_create_log WHERE ip = ? AND created_at >= ?').get(ip, cutoff);
  return count < RATE_MAX;
}

function recordRateLimit(ip) {
  db.prepare('INSERT INTO qr_create_log (ip, created_at) VALUES (?, ?)').run(ip, Date.now());
  // opportunistic GC
  if (Math.random() < 0.02) {
    db.prepare('DELETE FROM qr_create_log WHERE created_at < ?').run(Date.now() - RATE_WINDOW_MS);
  }
}

// --- handlers ---------------------------------------------------------------
async function handleRegister(req, res) {
  const body = await readJson(req);
  if (body === null) return sendJson(res, 400, { error: 'invalid json' });
  const label = (body?.label || '').slice(0, 100) || null;

  const token = randomToken(24);
  const tokenHash = hashToken(token);
  const ip = clientIp(req);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO agents (token_hash, label, registered_ip, created_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash, label, ip, now);

  sendJson(res, 200, {
    agentId: info.lastInsertRowid,
    agentToken: token,
    publicUrl: PUBLIC_URL,
  });
}

async function handleCreateQr(req, res) {
  const agent = authAgent(req);
  if (!agent) return sendJson(res, 401, { error: 'unauthorized' });

  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return sendJson(res, 429, { error: 'rate limit: max 10 QR creations per 10 minutes' });
  }

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM qr_codes WHERE agent_id = ?').get(agent.id);
  if (count >= HARD_CAP_PER_AGENT) {
    return sendJson(res, 403, { error: `hard cap reached: ${HARD_CAP_PER_AGENT} QRs per agent` });
  }

  const body = await readJson(req);
  if (body === null) return sendJson(res, 400, { error: 'invalid json' });

  const name = String(body.name || '').slice(0, 200).trim();
  const targetLabel = String(body.targetLabel || 'default').slice(0, 100).trim() || 'default';
  const singleUse = body.singleUse ? 1 : 0;
  const cooldownSeconds = Math.max(0, Math.min(3600, Number(body.cooldownSeconds) || 0));

  if (!name) return sendJson(res, 400, { error: 'name required' });

  const slug = randomSlug(10);
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO qr_codes (agent_id, slug, name, target_label, action, single_use, cooldown_seconds, created_at)
     VALUES (?, ?, ?, ?, 'win', ?, ?, ?)`
  ).run(agent.id, slug, name, targetLabel, singleUse, cooldownSeconds, now);

  recordRateLimit(ip);

  sendJson(res, 200, {
    id: info.lastInsertRowid,
    slug,
    name,
    targetLabel,
    singleUse: !!singleUse,
    cooldownSeconds,
    url: `${PUBLIC_URL}/s/${slug}`,
    createdAt: now,
  });
}

function handleListQr(req, res) {
  const agent = authAgent(req);
  if (!agent) return sendJson(res, 401, { error: 'unauthorized' });
  const rows = db.prepare(
    `SELECT id, slug, name, target_label AS targetLabel, single_use AS singleUse,
            cooldown_seconds AS cooldownSeconds, used_at AS usedAt,
            last_scan_at AS lastScanAt, created_at AS createdAt
       FROM qr_codes WHERE agent_id = ? ORDER BY id DESC`
  ).all(agent.id);
  for (const r of rows) {
    r.singleUse = !!r.singleUse;
    r.url = `${PUBLIC_URL}/s/${r.slug}`;
  }
  sendJson(res, 200, { qrCodes: rows });
}

function handleDeleteQr(req, res, slug) {
  const agent = authAgent(req);
  if (!agent) return sendJson(res, 401, { error: 'unauthorized' });
  const info = db.prepare('DELETE FROM qr_codes WHERE slug = ? AND agent_id = ?').run(slug, agent.id);
  if (info.changes === 0) return sendJson(res, 404, { error: 'not found' });
  sendJson(res, 200, { status: 'ok' });
}

function handleScan(req, res, slug) {
  const qr = db.prepare(
    `SELECT id, agent_id AS agentId, target_label AS targetLabel, action,
            single_use AS singleUse, cooldown_seconds AS cooldownSeconds,
            used_at AS usedAt, last_scan_at AS lastScanAt, name
       FROM qr_codes WHERE slug = ?`
  ).get(slug);
  if (!qr) return sendHtml(res, 404, '<h1>404</h1><p>Unknown QR.</p>');

  const now = Date.now();
  if (qr.singleUse && qr.usedAt) {
    return sendHtml(res, 410, '<h1>Already used</h1>');
  }
  if (qr.cooldownSeconds && qr.lastScanAt && now - qr.lastScanAt < qr.cooldownSeconds * 1000) {
    return sendHtml(res, 429, '<h1>Too fast</h1><p>Try again in a moment.</p>');
  }

  db.prepare('UPDATE qr_codes SET last_scan_at = ?, used_at = COALESCE(used_at, CASE WHEN single_use=1 THEN ? ELSE NULL END) WHERE id = ?').run(now, now, qr.id);

  const eventId = randomToken(8);
  db.prepare(
    `INSERT INTO scan_events (id, qr_code_id, agent_id, target_label, action, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, qr.id, qr.agentId, qr.targetLabel, qr.action, clientIp(req), req.headers['user-agent'] || '', now);

  const delivered = ssePush(qr.agentId, {
    id: eventId,
    slug,
    targetLabel: qr.targetLabel,
    action: qr.action,
    createdAt: now,
  });
  console.log(`[scan] slug=${slug} agent=${qr.agentId} event=${eventId} delivered=${delivered}`);

  sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>Scanned</title>
<body style="font-family:system-ui;text-align:center;padding:4rem;background:#0a0a0a;color:#fafafa">
<div style="font-size:5rem;color:#22c55e">✓</div>
<h1>Scanned</h1>
<p style="opacity:0.7">${escapeHtml(qr.name)}</p>
</body>`);
}

function handleStream(req, res) {
  const agent = authAgent(req);
  if (!agent) return sendJson(res, 401, { error: 'unauthorized' });

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`: connected\n\n`);

  const prev = subscribers.get(agent.id);
  if (prev) { try { prev.end(); } catch {} }
  subscribers.set(agent.id, res);
  console.log(`[stream] agent ${agent.id} connected`);

  // replay undelivered events (last 5 minutes)
  const cutoff = Date.now() - 5 * 60 * 1000;
  const undelivered = db.prepare(
    `SELECT se.id, qr.slug, se.target_label AS targetLabel, se.action, se.created_at AS createdAt
       FROM scan_events se JOIN qr_codes qr ON qr.id = se.qr_code_id
       WHERE se.agent_id = ? AND se.delivered_at IS NULL AND se.created_at >= ?
       ORDER BY se.created_at ASC`
  ).all(agent.id, cutoff);
  for (const ev of undelivered) {
    res.write(`id: ${ev.id}\n`);
    res.write(`event: scan\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (subscribers.get(agent.id) === res) subscribers.delete(agent.id);
    console.log(`[stream] agent ${agent.id} disconnected`);
  });
}

async function handleAck(req, res) {
  const agent = authAgent(req);
  if (!agent) return sendJson(res, 401, { error: 'unauthorized' });
  const body = await readJson(req);
  if (!body || !body.eventId) return sendJson(res, 400, { error: 'eventId required' });
  const info = db.prepare('UPDATE scan_events SET delivered_at = ? WHERE id = ? AND agent_id = ? AND delivered_at IS NULL').run(Date.now(), body.eventId, agent.id);
  if (info.changes === 0) return sendJson(res, 404, { error: 'unknown event' });
  sendJson(res, 200, { status: 'ok' });
}

// --- router -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const m = req.method;

    if (m === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (m === 'POST' && url.pathname === '/api/agents/register') return await handleRegister(req, res);
    if (m === 'POST' && url.pathname === '/api/qr') return await handleCreateQr(req, res);
    if (m === 'GET' && url.pathname === '/api/qr') return handleListQr(req, res);
    if (m === 'DELETE' && url.pathname.startsWith('/api/qr/')) return handleDeleteQr(req, res, url.pathname.slice(8));
    if (m === 'GET' && url.pathname === '/api/agent/stream') return handleStream(req, res);
    if (m === 'POST' && url.pathname === '/api/agent/ack') return await handleAck(req, res);

    if (m === 'GET' && url.pathname.startsWith('/s/')) return handleScan(req, res, url.pathname.slice(3));

    if (m === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><title>qrcodeuupc</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>qr.allescaperoompuzzles.com</h1>
<p>Pobierz lokalną aplikację, podaj IP swojego UUPC, wygeneruj QR.</p>
<p>Po szczegóły zobacz <a href="https://github.com/escaperoomsupplier/qrcodeuupc">repo</a>.</p>
</body>`);
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[error]', err);
    sendJson(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on ${PUBLIC_URL}`);
});
