#!/usr/bin/env bash
# Idempotent bootstrap for a fresh Ubuntu 24.04 Hetzner VPS.
#
# Run as root, e.g.:
#   curl -fsSL https://raw.githubusercontent.com/sethshoultes/gauntlet-crawler/main/deploy/setup-server.sh | bash
#
# Env overrides:
#   REPO_URL  (default: https://github.com/sethshoultes/gauntlet-crawler.git)
#   BRANCH    (default: main)
#   APP_DIR   (default: /opt/gauntlet-crawler)
#   DEPLOY_USER (default: deploy)
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/sethshoultes/gauntlet-crawler.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/gauntlet-crawler}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (e.g. via sudo)." >&2
  exit 1
fi

log() { echo "==> $*"; }

log "Updating apt package lists"
apt-get update -y

log "Installing base packages"
apt-get install -y --no-install-recommends ca-certificates curl git ufw

# ---- Docker ----
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker via the official convenience script"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
else
  log "Docker already installed, skipping"
fi

if ! docker compose version >/dev/null 2>&1; then
  log "Installing docker-compose-plugin"
  apt-get install -y --no-install-recommends docker-compose-plugin
else
  log "docker compose plugin already present, skipping"
fi

systemctl enable --now docker

# ---- deploy user ----
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "Creating user '$DEPLOY_USER'"
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
else
  log "User '$DEPLOY_USER' already exists, skipping"
fi

if ! id -nG "$DEPLOY_USER" | grep -qw docker; then
  log "Adding '$DEPLOY_USER' to the docker group"
  usermod -aG docker "$DEPLOY_USER"
fi

mkdir -p "$APP_DIR"

# ---- firewall ----
if command -v ufw >/dev/null 2>&1; then
  log "Configuring ufw (22, 80, 443)"
  ufw allow 22/tcp || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
  if ufw status | grep -q "Status: inactive"; then
    ufw --force enable
  else
    log "ufw already enabled, skipping enable step"
  fi
fi

# ---- clone / update repo ----
if [ -d "$APP_DIR/.git" ]; then
  log "Repository already present at $APP_DIR, fetching latest"
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_URL (branch $BRANCH) into $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"

# ---- env file ----
if [ ! -f "$APP_DIR/.env" ]; then
  log "Creating $APP_DIR/.env from deploy/.env.example (edit this before relying on the AI level generator or a real domain)"
  cp "$APP_DIR/deploy/.env.example" "$APP_DIR/.env"
  chown "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR/.env"
else
  log ".env already exists, leaving it untouched"
fi

# ---- bring the stack up ----
log "Building and starting the stack with docker compose"
(cd "$APP_DIR" && docker compose up -d --build)

cat <<EOF

==================================================================
Gauntlet Crawler setup complete.

Next steps:
  1. Point your domain's DNS A/AAAA record at this server's IP.
  2. Edit $APP_DIR/.env and set DOMAIN (and ANTHROPIC_API_KEY if you
     want the AI level generator), then run:
       cd $APP_DIR && docker compose up -d --build
  3. For automatic deploys from GitHub Actions, add these repo
     secrets: DEPLOY_HOST, DEPLOY_USER (e.g. "$DEPLOY_USER"),
     DEPLOY_SSH_KEY (private key whose public half is authorized for
     that user), and optionally DEPLOY_PORT.
  4. Check container status with:
       cd $APP_DIR && docker compose ps
       docker compose logs -f app
==================================================================
EOF
