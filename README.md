# qrcodeuupc

QR code → cloud → local agent → UUPC win. Trigger an Ultimate Universal Puzzle Controller "win" by scanning a printed QR code.

## Architecture

```
phone scans QR → https://qr.allescaperoompuzzles.com/s/<slug>
                                  │
                                  ▼
                       mikrus Next.js app (later)
                       mock-server/ (for now)
                                  │ SSE push
                                  ▼
                       agent.exe (LAN PC)
                                  │ POST /machine/state value=2
                                  ▼
                       UUPC 192.168.1.38
```

## Repo layout

- `agent/` — local Node.js agent that connects to the server via SSE and POSTs `value=2` to UUPC `/machine/state` on each scan. Builds to `agent.exe` via `@yao-pkg/pkg`.
- `mock-server/` — minimal SSE server used during development before the real Next.js subdomain is live.
- `fake-uupc/` — tiny HTTP server that pretends to be a UUPC so the agent can be tested without LAN hardware.
- `mikrus/` — deployment scripts for the production Next.js app on the mikrus VPS (already deployed).

## Quick start (dev)

```sh
# Terminal 1: fake UUPC on :9100
cd fake-uupc && node index.js

# Terminal 2: mock server on :8080
cd mock-server && node index.js

# Terminal 3: agent (config points at localhost:8080 + localhost:9100)
cd agent && node index.js

# Terminal 4: trigger a scan
curl http://localhost:8080/s/demo
```

Expected: fake-uupc logs `machine_state=2 (WIN)`.

## UUPC API

The agent POSTs `value=2` to `http://<uupc_ip>/machine/state`. See
https://wiki.escaperoomsupplier.com/wiki/Ultimate_Universal_Puzzle_Controller_API
