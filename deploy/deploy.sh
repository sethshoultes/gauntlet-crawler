#!/usr/bin/env bash
# Run on the production server (by CI over SSH, or manually) to pull the
# latest code and redeploy the stack.
#
# Env overrides:
#   APP_DIR  (default: /opt/gauntlet-crawler)
#   BRANCH   (default: main)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/gauntlet-crawler}"
BRANCH="${BRANCH:-main}"

log() { echo "==> $*"; }

cd "$APP_DIR"

log "Fetching latest from origin"
git fetch --all
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

log "Building and starting the stack"
docker compose up -d --build --remove-orphans

log "Pruning dangling images"
docker image prune -f

log "Waiting for the app to report healthy"
ATTEMPTS=30
SLEEP_SECONDS=2
ok=0
for i in $(seq 1 "$ATTEMPTS"); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/ai/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep "$SLEEP_SECONDS"
done

if [ "$ok" -ne 1 ]; then
  echo "Deploy failed: /api/ai/status did not respond after $((ATTEMPTS * SLEEP_SECONDS))s" >&2
  docker compose logs --tail=100 app >&2 || true
  exit 1
fi

log "Deploy successful, app is healthy"
