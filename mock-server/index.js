import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8080);

// --- demo data ---------------------------------------------------------------
// In production this comes from SQLite. Here it's in-memory and re-seeded on boot.
const AGENT_TOKEN = 'demo-agent-token-xyz';

/** @type {Map<string, {agentToken: string, targetLabel: string, action: string, singleUse: boolean, cooldownSeconds: number, usedAt: number|null, lastScanAt: number|null}>} */
const qrCodes = new Map();
qrCodes.set('demo', {
  agentToken: AGENT_TOKEN,
  targetLabel: 'default',
  action: 'win',
  singleUse: false,
  cooldownSeconds: 2,
  usedAt: null,
  lastScanAt: null,
});
qrCodes.set('once', {
  agentToken: AGENT_TOKEN,
  targetLabel: 'default',
  action: 'win',
  singleUse: true,
  cooldownSeconds: 0,
  usedAt: null,
  lastScanAt: null,
});

/** @type {Array<{id: string, agentToken: string, slug: string, targetLabel: string, action: string, createdAt: number, deliveredAt: number|null}>} */
const events = [];

/** @type {Map<string, http.ServerResponse>} agentToken -> active SSE response */
const subscribers = new Map();

// --- helpers -----------------------------------------------------------------
function id() {
  return randomBytes(8).toString('hex');
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

function ssePush(token, ev) {
  const res = subscribers.get(token);
  if (!res) return false;
  res.write(`id: ${ev.id}\n`);
  res.write(`event: scan\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
  return true;
}

// --- handlers ----------------------------------------------------------------
async function handleScan(req, res, slug) {
  const qr = qrCodes.get(slug);
  if (!qr) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1><p>Unknown QR code.</p>');
    return;
  }

  const now = Date.now();
  if (qr.singleUse && qr.usedAt) {
    res.writeHead(410, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Already used</h1><p>This QR has already been scanned.</p>');
    return;
  }
  if (qr.cooldownSeconds && qr.lastScanAt && now - qr.lastScanAt < qr.cooldownSeconds * 1000) {
    res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Too fast</h1><p>Try again in a moment.</p>');
    return;
  }

  qr.lastScanAt = now;
  if (qr.singleUse) qr.usedAt = now;

  const ev = {
    id: id(),
    agentToken: qr.agentToken,
    slug,
    targetLabel: qr.targetLabel,
    action: qr.action,
    createdAt: now,
    deliveredAt: null,
  };
  events.push(ev);
  const delivered = ssePush(qr.agentToken, ev);
  console.log(`[scan] slug=${slug} event=${ev.id} delivered=${delivered}`);

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Scanned</title>
<body style="font-family:system-ui;text-align:center;padding:4rem">
<h1 style="font-size:4rem">✓</h1>
<p>Scanned. The puzzle has been triggered.</p>
</body>`);
}

function handleStream(req, res) {
  const token = getBearer(req);
  if (!token || token !== AGENT_TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no', // hint for nginx
  });
  res.write(`: connected\n\n`);

  const prev = subscribers.get(token);
  if (prev) {
    try { prev.end(); } catch {}
  }
  subscribers.set(token, res);
  console.log(`[stream] agent connected token=${token.slice(0, 8)}...`);

  // replay undelivered events (within last 5 minutes)
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const ev of events) {
    if (ev.agentToken !== token) continue;
    if (ev.deliveredAt) continue;
    if (ev.createdAt < cutoff) continue;
    res.write(`id: ${ev.id}\n`);
    res.write(`event: scan\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`);
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (subscribers.get(token) === res) subscribers.delete(token);
    console.log(`[stream] agent disconnected token=${token.slice(0, 8)}...`);
  });
}

async function handleAck(req, res) {
  const token = getBearer(req);
  if (!token || token !== AGENT_TOKEN) {
    res.writeHead(401);
    res.end();
    return;
  }
  const body = await readBody(req);
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  const eventId = parsed.eventId;
  const ev = events.find((e) => e.id === eventId);
  if (!ev) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown event' }));
    return;
  }
  ev.deliveredAt = Date.now();
  console.log(`[ack] event=${eventId}`);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

// --- router ------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname.startsWith('/s/')) {
    const slug = url.pathname.slice(3);
    await handleScan(req, res, slug);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/stream') {
    handleStream(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/ack') {
    await handleAck(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`mock server\n\nDemo QR slugs:\n  /s/demo (reusable, 2s cooldown)\n  /s/once (single use)\n\nAgent token: ${AGENT_TOKEN}\n`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[mock-server] listening on http://localhost:${PORT}`);
  console.log(`[mock-server] agent token: ${AGENT_TOKEN}`);
  console.log(`[mock-server] try: curl http://localhost:${PORT}/s/demo`);
});
