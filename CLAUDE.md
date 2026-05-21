# CLAUDE.md

## What this project is

Scan a printed QR code → an Ultimate Universal Puzzle Controller (UUPC) on a customer's LAN enters the WIN state. The QR contains a public URL on `qr.allescaperoompuzzles.com`; that URL pushes an event over SSE to a small local app the customer runs, which POSTs `value=2` to `http://<uupc_ip>/machine/state`.

UUPC API reference: https://wiki.escaperoomsupplier.com/wiki/Ultimate_Universal_Puzzle_Controller_API

## Architecture

```
phone (any internet) → https://qr.allescaperoompuzzles.com/s/<slug>
                            │
                            │ Cloudflare proxy (IPv4 + IPv6)
                            ▼
                       nginx :443 on VPS
                            │
                            │ proxy_pass (SSE-friendly: buffering off, 1h timeout)
                            ▼
                       node /var/www/qrcodeuupc/server (systemd: qrcodeuupc.service)
                       SQLite at /var/lib/qrcodeuupc/app.sqlite
                            │
                            │ SSE push to whichever local app is subscribed for this agent token
                            ▼
                       qr-uupc.exe on customer's PC
                       (HTTP server on localhost:8765 + SSE consumer in same process)
                            │
                            │ POST http://<uupc_ip>/machine/state value=2
                            ▼
                       UUPC (no auth on HTTP API)
```

## Repo layout

| Path | Role |
|---|---|
| `server/` | Cloud relay API. Node + SQLite (`better-sqlite3`). No UI, no login. Endpoints: `POST /api/agents/register`, `POST /api/qr`, `GET /api/qr`, `DELETE /api/qr/:slug`, `GET /s/:slug` (public scan), `GET /api/agent/stream` (SSE, Bearer auth), `POST /api/agent/ack`, `GET /healthz`. |
| `agent/` | The customer-facing local app. Single Node script that runs both an HTTP server (web UI on `localhost:8765`) and an SSE consumer + UUPC trigger in the same process. Builds to `qr-uupc.exe` (~44 MB) via `@yao-pkg/pkg`. **CJS, not ESM** — pkg's ESM handling is unreliable. |
| `fake-uupc/` | Tiny HTTP server that pretends to be a UUPC for offline testing. POST `/machine/state value=N` logs and returns `{status:ok, machine_state:N}`. |
| `mikrus/` | Deploy artifacts for the VPS: `qrcodeuupc.service` (systemd), `qrcodeuupc.nginx.conf`, `deploy-qr.sh`. Existing files for the main `allescaperoompuzzles.com` site live here too — don't touch them. |

## Production

- **Cloud**: `https://qr.allescaperoompuzzles.com` → nginx → `127.0.0.1:3001` → systemd `qrcodeuupc.service` (User=aerp, WorkingDirectory=`/var/www/qrcodeuupc/server`, EnvironmentFile=`/etc/qrcodeuupc.env`, ExecStart=`/usr/bin/node index.js`, Restart=always).
- **DB**: SQLite at `/var/lib/qrcodeuupc/app.sqlite` (path set via `DATABASE_PATH` in `/etc/qrcodeuupc.env`).
- **TLS**: Let's Encrypt via certbot, auto-renew.
- **DNS**: Cloudflare, `qr` AAAA → VPS IPv6 `2a01:4f9:3a:12c8::240`, **Proxy: Proxied** (orange cloud). The proxy is required so IPv4-only clients (most mobile carriers, most home WiFi) can resolve the domain. Cloudflare proxies SSE correctly — heartbeats every 15s in code prevent any idle-timeout.
- **VPS access**: `ssh -p 10240 root@robert240.mikrus.xyz` (mikrus.xyz VPS, IPv6-only origin; CGNAT IPv4 used only for SSH port-forward).
- **Cloud server logs**: `journalctl -u qrcodeuupc -f` on the VPS.

## Local app (qr-uupc.exe)

- Customer downloads from [GitHub Releases](https://github.com/escaperoomsupplier/qrcodeuupc/releases), runs the exe.
- Opens `http://localhost:8765` automatically; UI is in English.
- On first run, anonymously registers with the cloud → gets an `agentToken`, stored in `local-data.json` next to the exe.
- `local-data.json` shape: `{ serverUrl, publicUrl, agentId, agentToken, qrMappings: { slug → { ip, name, singleUse, cooldownSeconds, createdAt } }, uupcTimeoutMs }`. Also `agent.log` with 5 MB rotation.
- For each QR the user creates: app POSTs to cloud `/api/qr`, gets a slug back, stores `slug → ip` locally (cloud never sees the LAN IP).
- On scan event over SSE: looks up the ip from `qrMappings[slug]`, POSTs `value=2` to UUPC, then `/api/agent/ack`. Failed UUPC posts are NOT acked → cloud will replay on next reconnect.

## Cloud DB schema (`server/db.js`)

- `agents (id, token_hash, label, registered_ip, created_at, last_seen_at)` — anonymous, one per local app installation. Token is hashed (sha256) in storage, plaintext only at registration.
- `qr_codes (id, agent_id, slug, name, target_label, action='win', single_use, cooldown_seconds, used_at, last_scan_at, created_at)`. The `target_label` is unused in the current UX (we always use the slug for local lookup); kept for future multi-UUPC-per-agent flexibility.
- `scan_events (id, qr_code_id, agent_id, target_label, action, ip, user_agent, created_at, delivered_at)` — replay store. `id` is the SSE event id.
- `qr_create_log (id, ip, created_at)` — rate limit log (10 creates per 10 min per source IP, hard cap 100 QRs per agent).

## Dev

```sh
# terminal 1 — cloud
cd server && pnpm install && pnpm start            # :3001

# terminal 2 — fake UUPC (optional, when you don't have hardware)
cd fake-uupc && pnpm start                          # :9100

# terminal 3 — local app pointed at local cloud
cd agent
pnpm install
QR_SERVER_URL=http://localhost:3001 NO_OPEN_BROWSER=1 pnpm start  # :8765

# trigger a scan from a 4th terminal:
curl http://localhost:3001/s/<slug>
```

Set `uupcMap.default` in the UI to `http://localhost:9100` when using fake-uupc, or `http://192.168.1.38` for the real test device.

## Build & release (the local app)

1. **Bump version** in `agent/package.json` (semver: feature → minor, fix → patch). The version is read by `require('./package.json')` and logged on startup.
2. `cd agent && pnpm run build` → `qr-uupc.exe` (~44 MB, standalone Node 20).
3. Smoke-test: `mkdir tmp && cp qr-uupc.exe tmp/ && cd tmp && NO_OPEN_BROWSER=1 ./qr-uupc.exe` → should log version, register, `SSE connected`.
4. **Create a NEW release tag** — never re-upload to an existing one:
   ```sh
   gh release create vX.Y.Z agent/qr-uupc.exe --repo escaperoomsupplier/qrcodeuupc --title "..." --notes "..."
   ```
5. Commit the `package.json` bump in the same change set.

## Deploy (the cloud server)

After pushing to `main`:

```sh
ssh -p 10240 root@robert240.mikrus.xyz 'bash -s' < mikrus/deploy-qr.sh
```

The script clones/pulls `escaperoomsupplier/qrcodeuupc.git` into `/var/www/qrcodeuupc`, runs `npm install --omit=dev` in `server/` (see gotcha below), installs the systemd unit + nginx site, reloads both, and prints status.

For the very first deploy (or to renew certificate):
```sh
certbot --nginx -d qr.allescaperoompuzzles.com
```

## Gotchas (learned the hard way)

- **`@yao-pkg/pkg` + ESM is unreliable** — agent is CJS (`require`, no `"type":"module"` in `agent/package.json`).
- **`pkg` + native modules don't mix** — that's why the agent uses pure-JS `qrcode` and the cloud uses native `better-sqlite3`. Don't add native deps to `agent/`.
- **pnpm 11 blocks postinstall scripts** by default. `better-sqlite3` needs its postinstall to fetch the prebuilt binary. The deploy script uses `npm install` (not pnpm) for `server/` for this reason. `agent/` uses pnpm for dev because its deps are pure-JS.
- **The cloud serves over IPv6 only**; Cloudflare proxy gives it IPv4 for mobile clients. If you ever set `qr` to "DNS only" again, iPhones on cellular data will get NXDOMAIN.
- **SSE through nginx needs `proxy_buffering off`** + long `proxy_read_timeout`. Configured in `mikrus/qrcodeuupc.nginx.conf`. Also `proxy_buffering off` on Cloudflare's side is handled automatically; the 15s heartbeat in `server/index.js` keeps the connection alive.
- **Server SQLite path depends on cwd** unless `DATABASE_PATH` env var is set. The systemd unit sets `WorkingDirectory=/var/www/qrcodeuupc/server` and `/etc/qrcodeuupc.env` overrides path to `/var/lib/qrcodeuupc/app.sqlite`. Don't `cd` to a different dir and run the server — you'll create a second DB.
- **Rate limit is per source IP** of whoever calls `POST /api/qr`. That means multiple customers behind the same NAT/CGNAT share the budget (10/10min). The hard cap (100 QRs per agent) is the more meaningful limit.
- **`/s/<slug>` cooldown / single-use is enforced on the cloud** before pushing the event, so the local app can't be DoS'd through scan spam.

## Test against the real UUPC (192.168.1.38)

When on the LAN with the UUPC:
```sh
curl http://192.168.1.38/machine/state                      # current state
curl -X POST http://192.168.1.38/machine/state -d 'value=0' # ARMED
curl -X POST http://192.168.1.38/machine/state -d 'value=2' # WIN
```

States: `0 ARMED, 1 IN_PROGRESS, 2 WIN, 3 LEARNING`.

## Conventions

- All user-facing UI strings are in English (the customer base is international).
- Comments only when WHY is non-obvious; we deleted boilerplate during the pivot to keep the code surface area small.
- One `package.json` per component (no monorepo tooling). Each has its own `node_modules`.
- Versioning: agent has its own version. Server doesn't need releases (deployed directly from `main`).
- No tests yet. End-to-end verified by running the actual stack against the real UUPC.
