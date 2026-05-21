# qrcodeuupc

Wygeneruj kod QR. Wydrukuj. Jak ktoś go zeskanuje — UUPC w sieci lokalnej wygrywa.

## Jak to działa

```
telefon skanuje QR → https://qr.allescaperoompuzzles.com/s/<slug>
                                      │
                                      │ SSE push (długie HTTPS)
                                      ▼
                       qr-uupc.exe (LAN, web UI na localhost:8765)
                                      │
                                      │ POST /machine/state value=2
                                      ▼
                       UUPC 192.168.1.38
```

## Dla klienta końcowego (Windows)

1. Pobierz `qr-uupc.exe` z [Releases](https://github.com/escaperoomsupplier/qrcodeuupc/releases).
2. Włóż do dowolnego folderu, kliknij dwa razy.
3. Otworzy się przeglądarka na `http://localhost:8765`.
4. Wpisz nazwę QR, IP swojego UUPC, kliknij „Wygeneruj".
5. Wydrukuj QR. Gotowe.

Apka musi być uruchomiona w trakcie używania (najlepiej w autostarcie: skrót w `Win+R → shell:startup`).

## Repo

- `agent/` — lokalna apka klienta z web UI; buduje się do `qr-uupc.exe` (`@yao-pkg/pkg`)
- `server/` — chmurowy serwer API + relay SSE (Node.js + SQLite via `better-sqlite3`)
- `fake-uupc/` — symulator UUPC do testów bez sprzętu
- `mikrus/` — artefakty deploymentu na VPS

## Dev

```sh
# 1. cloud server (jeden raz)
cd server && pnpm install

# 2. lokalna apka
cd agent && pnpm install

# uruchomienie obu (osobne terminale):
cd server && pnpm start
cd agent  && QR_SERVER_URL=http://localhost:3001 pnpm start
```

Apka lokalna sama się zarejestruje w chmurze przy 1. uruchomieniu (token → `local-data.json`).

## Testowanie bez prawdziwego UUPC

```sh
cd fake-uupc && pnpm start          # :9100
cd server    && pnpm start          # :3001
cd agent     && QR_SERVER_URL=http://localhost:3001 pnpm start  # :8765
# w UI: utwórz QR z IP = http://localhost:9100
# scan: curl http://localhost:3001/s/<slug>
```

## Deploy serwera na mikrus

Wymaga uruchomionego głównego setupu z `allescaperoompuzzles` (utworzył usera `aerp`, zainstalował Node, nginx, certbot).

```sh
# na VPS jako root:
bash mikrus/deploy-qr.sh

# w GoDaddy DNS: A/AAAA "qr" -> ten sam IP co allescaperoompuzzles.com
# po propagacji:
certbot --nginx -d qr.allescaperoompuzzles.com
```

## UUPC API

Apka POSTuje `value=2` na `http://<uupc_ip>/machine/state`. Szczegóły:
https://wiki.escaperoomsupplier.com/wiki/Ultimate_Universal_Puzzle_Controller_API
