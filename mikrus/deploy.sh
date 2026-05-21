#!/usr/bin/env bash
set -euo pipefail

APP_USER="aerp"
APP_DIR="/var/www/allescaperoompuzzles"
DATA_DIR="/var/lib/allescaperoompuzzles"
ENV_FILE="/etc/allescaperoompuzzles.env"
REPO_URL="https://github.com/plejsq/allescaperoompuzzles.git"
SOURCE_DIR="${SOURCE_DIR:-}"

if [ -n "$SOURCE_DIR" ]; then
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR"
  cp -a "$SOURCE_DIR"/. "$APP_DIR"/
elif [ ! -d "$APP_DIR/.git" ]; then
  CLONE_DIR="$(mktemp -d)"
  trap 'rm -rf "$CLONE_DIR"' EXIT
  git clone "$REPO_URL" "$CLONE_DIR/app"
  rm -rf "$APP_DIR"
  mv "$CLONE_DIR/app" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cd "$APP_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm build
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

install -m 0644 deploy/mikrus/allescaperoompuzzles.service /etc/systemd/system/allescaperoompuzzles.service
if [ ! -f /etc/letsencrypt/live/allescaperoompuzzles.com/fullchain.pem ]; then
  install -m 0644 deploy/mikrus/nginx.conf /etc/nginx/sites-available/allescaperoompuzzles
fi
ln -sfn /etc/nginx/sites-available/allescaperoompuzzles /etc/nginx/sites-enabled/allescaperoompuzzles
rm -f /etc/nginx/sites-enabled/default

systemctl daemon-reload
systemctl enable allescaperoompuzzles
systemctl restart allescaperoompuzzles
nginx -t
systemctl reload nginx

echo "Deployment complete."
echo "After GoDaddy DNS points to 2a01:4f9:3a:12c8::240, run:"
echo "certbot --nginx -d allescaperoompuzzles.com -d www.allescaperoompuzzles.com"
