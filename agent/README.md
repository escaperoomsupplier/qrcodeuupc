# qr-uupc.exe (lokalna apka)

Apka działająca lokalnie na komputerze z dostępem do UUPC w sieci LAN. Dwie funkcje w jednym procesie:

- **Web UI** na `http://localhost:8765` — generujesz QR, ustawiasz IP UUPC, drukujesz
- **SSE klient** do `qr.allescaperoompuzzles.com` — na każdy scan QR wystrzeliwuje `value=2` do UUPC (`/machine/state`)

## Użycie

1. Uruchom `qr-uupc.exe`. Pierwsze uruchomienie zarejestruje się anonimowo w chmurze i zapisze token do `local-data.json` obok exe.
2. Otworzy się przeglądarka. Wpisz nazwę i IP UUPC, kliknij „Wygeneruj QR".
3. Wydrukuj.

Apka musi być uruchomiona w momencie skanowania QR. Autostart: skrót w `Win+R → shell:startup`.

## Zmienne środowiskowe

- `QR_SERVER_URL` — domyślnie `https://qr.allescaperoompuzzles.com`; ustaw na lokalny serwer w dev.
- `PORT` — domyślnie 8765 (port web UI).
- `NO_OPEN_BROWSER=1` — nie otwieraj przeglądarki automatycznie.

## Pliki tworzone obok exe

- `local-data.json` — token + lista QR (slug → IP)
- `agent.log` — log działania (rotacja po 5 MB → `agent.log.1`)

## Build z kodu

```sh
pnpm install
pnpm run build
# → qr-uupc.exe (~44 MB, standalone Node 20)
```

## Dev (bez budowania exe)

```sh
pnpm install
QR_SERVER_URL=http://localhost:3001 pnpm start
```
