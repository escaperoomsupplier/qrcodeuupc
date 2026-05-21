# qrcodeuupc agent

Lokalny agent łączący się z `qr.allescaperoompuzzles.com` i wyzwalający stan **WIN** na UUPC w sieci LAN.

## Instalacja (dla klienta końcowego)

1. Pobierz `agent.exe` z [Releases].
2. W tym samym folderze co `agent.exe` utwórz `config.json` (skopiuj z `config.example.json` i edytuj):

   ```json
   {
     "serverUrl": "https://qr.allescaperoompuzzles.com",
     "agentToken": "ak_xxx (token pokoju z panelu)",
     "uupcMap": {
       "default": "192.168.1.38"
     },
     "uupcTimeoutMs": 3000
   }
   ```

3. Odpal `agent.exe` (dwuklik). Powinien wyświetlić `stream connected`.
4. Żeby uruchamiał się przy starcie systemu: skrót do `agent.exe` w `Win+R` → `shell:startup`.

## uupcMap

Klucz `default` jest używany dla każdego QR, który w panelu ma `target_label = "default"`. Jeśli masz kilka UUPC w pokoju, dodaj kolejne klucze:

```json
"uupcMap": {
  "default": "192.168.1.38",
  "uupc-frontdoor": "192.168.1.39",
  "uupc-vault": "192.168.1.40"
}
```

Wartość może być samym IP (`192.168.1.38`), `host:port`, albo pełnym URL-em (`http://192.168.1.38`).

## Logi

Agent zapisuje `agent.log` w folderze z `agent.exe` (z rotacją po 5 MB → `agent.log.1`).

## Build z kodu źródłowego

```sh
pnpm install
pnpm run build
# → ./agent.exe (~42 MB, standalone Node 20 win-x64)
```

## Dev (bez budowania exe)

```sh
node index.js
# albo z innym configiem:
node index.js --config /path/to/config.json
```
