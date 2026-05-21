#!/usr/bin/env bash
set -euo pipefail

APP_USER="aerp"
APP_DIR="/var/www/allescaperoompuzzles"
DATA_DIR="/var/lib/allescaperoompuzzles"
ENV_FILE="/etc/allescaperoompuzzles.env"

apt-get update
apt-get install -y ca-certificates curl gnupg git nginx sqlite3 build-essential python3 certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi

corepack enable
corepack prepare pnpm@8.15.9 --activate

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV'
DATABASE_URL=file:/var/lib/allescaperoompuzzles/app.sqlite
NEXTAUTH_URL=https://allescaperoompuzzles.com
MAGIC_LINK_FROM="All Escape Room Puzzles <login@allescaperoompuzzles.com>"
RESEND_API_KEY=
ADMIN_EMAILS=plejsq@gmail.com
ENV
  chmod 600 "$ENV_FILE"
fi

echo "Server prerequisites installed."
echo "Review $ENV_FILE and set RESEND_API_KEY before production login emails are expected to work."
