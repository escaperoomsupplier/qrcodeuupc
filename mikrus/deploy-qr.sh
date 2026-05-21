#!/usr/bin/env bash
# Deploy qrcodeuupc cloud server to mikrus.
# Run as root on the VPS after `setup-server.sh` from the main project has been executed
# (it already installed node 24, nginx, certbot, and created the 'aerp' system user).

set -euo pipefail

APP_USER="aerp"
APP_DIR="/var/www/qrcodeuupc"
DATA_DIR="/var/lib/qrcodeuupc"
ENV_FILE="/etc/qrcodeuupc.env"
REPO_URL="https://github.com/escaperoomsupplier/qrcodeuupc.git"
DOMAIN="qr.allescaperoompuzzles.com"
SOURCE_DIR="${SOURCE_DIR:-}"

if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User $APP_USER does not exist. Run setup-server.sh from allescaperoompuzzles first."
  exit 1
fi

apt-get install -y build-essential python3 sqlite3

mkdir -p "$APP_DIR" "$DATA_DIR"

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
  git config --global --add safe.directory "$APP_DIR"
  git -C "$APP_DIR" fetch origin main
  git -C "$APP_DIR" reset --hard origin/main
fi

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
PORT=3001
PUBLIC_URL=https://${DOMAIN}
DATABASE_PATH=${DATA_DIR}/app.sqlite
ENV
  chmod 600 "$ENV_FILE"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

cd "$APP_DIR/server"
# Use npm (not pnpm) for the server install — better-sqlite3 needs its
# postinstall to download the prebuilt binary, which pnpm 11 blocks unless
# the package is explicitly allowlisted via mechanisms that vary by version.
rm -rf node_modules
sudo -u "$APP_USER" npm install --omit=dev

install -m 0644 "$APP_DIR/mikrus/qrcodeuupc.service" /etc/systemd/system/qrcodeuupc.service

if [ ! -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem ]; then
  install -m 0644 "$APP_DIR/mikrus/qrcodeuupc.nginx.conf" /etc/nginx/sites-available/qrcodeuupc
fi
ln -sfn /etc/nginx/sites-available/qrcodeuupc /etc/nginx/sites-enabled/qrcodeuupc

systemctl daemon-reload
systemctl enable qrcodeuupc
systemctl restart qrcodeuupc
nginx -t
systemctl reload nginx

echo
echo "qrcodeuupc deployed."
echo
echo "Next steps (one-time):"
echo "  1. In GoDaddy DNS, add A/AAAA record: qr -> same IP as allescaperoompuzzles.com"
echo "  2. After DNS propagates, run:"
echo "     certbot --nginx -d ${DOMAIN}"
echo
echo "Service status:"
systemctl status qrcodeuupc --no-pager -l | head -15
