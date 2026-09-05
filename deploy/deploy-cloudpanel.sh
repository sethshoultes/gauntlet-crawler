#!/usr/bin/env bash
# Redeploy on a CloudPanel host where the game runs as a Node.js site under pm2
# (no Docker). Run as the site user; the GitHub deploy workflow calls this when
# it finds it at $HOME/deploy.sh on the target server.
#
# Env overrides:
#   APP     (default: $HOME/htdocs/<first directory in htdocs>)
#   BRANCH  (default: main)
#   PORT    (default: 3000)
set -euo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP="${APP:-$(ls -d "$HOME"/htdocs/*/ | head -1)}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-3000}"

cd "$APP"
git fetch --all -q
git checkout -q "$BRANCH"
git reset -q --hard "origin/$BRANCH"
npm ci --omit=dev 2>&1 | tail -1

export PORT DATA_DIR="$HOME/data"
mkdir -p "$DATA_DIR"
pm2 restart gauntlet --update-env >/dev/null 2>&1 \
  || pm2 start server/index.js --name gauntlet --node-args="--no-warnings=ExperimentalWarning" >/dev/null
pm2 save >/dev/null

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "deploy ok: $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done
echo "deploy failed: app not healthy" >&2
pm2 logs gauntlet --lines 40 --nostream >&2 || true
exit 1
