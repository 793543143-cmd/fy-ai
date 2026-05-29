#!/bin/zsh
set -u

APP_DIR="/Users/bajia/Documents/Codex/2026-05-14/sora-sora2-api"
NODE="/usr/local/bin/node"
PORT_URL="http://127.0.0.1:4173/api/state"

cd "$APP_DIR" || exit 1

while true; do
  if /usr/bin/curl -fsS --max-time 3 "$PORT_URL" >/dev/null 2>&1; then
    sleep 10
    continue
  fi

  "$NODE" "$APP_DIR/server.js"
  sleep 3
done
