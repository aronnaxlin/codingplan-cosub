#!/bin/bash
# Safe deployment script for coding-plan-proxy
# Usage: ./deploy.sh user@server:/path/to/app
#
# This script:
# 1. Builds the frontend
# 2. Creates a tarball excluding .env and data/
# 3. Uploads via scp
# 4. Extracts on remote without overwriting .env or data/

set -e

REMOTE_PATH="${1:-}"
if [ -z "$REMOTE_PATH" ]; then
  echo "Usage: ./deploy.sh user@host:/path/to/app"
  exit 1
fi

echo "[1/4] Building frontend..."
npm run build

echo "[2/4] Creating deployment archive..."
# Create temp dir for clean packaging
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Copy only deployable files
mkdir -p "$TMPDIR/coding-plan-proxy"
cp -r server/ "$TMPDIR/coding-plan-proxy/"
cp -r dist/ "$TMPDIR/coding-plan-proxy/"
cp package*.json "$TMPDIR/coding-plan-proxy/"
cp Dockerfile "$TMPDIR/coding-plan-proxy/" 2>/dev/null || true
cp docker-compose.yml "$TMPDIR/coding-plan-proxy/" 2>/dev/null || true
cp .env.example "$TMPDIR/coding-plan-proxy/"

cd "$TMPDIR"
tar czf deploy.tar.gz coding-plan-proxy/

echo "[3/4] Uploading to $REMOTE_PATH ..."
scp deploy.tar.gz "$REMOTE_PATH/../deploy.tar.gz"

echo "[4/4] Extracting on remote (preserving .env and data/)..."
ssh "${REMOTE_PATH%%:*}" "
  cd ${REMOTE_PATH#*:} && \
  echo 'Backing up .env and data/ if they exist...' && \
  [ -f .env ] && cp .env /tmp/.env.backup.$$.$(date +%s) && echo 'Backed up .env' || true && \
  [ -d data ] && cp -r data /tmp/data.backup.$$.$(date +%s) && echo 'Backed up data/' || true && \
  echo 'Extracting new code...' && \
  tar xzf ../deploy.tar.gz -C . --strip-components=1 --exclude='.env' --exclude='data' && \
  echo 'Installing dependencies...' && \
  npm ci --omit=dev && \
  echo 'Restarting app...' && \
  # If using pm2:
  # pm2 restart coding-plan-proxy || pm2 start server/index.js --name coding-plan-proxy || \
  # If using systemd:
  # sudo systemctl restart coding-plan-proxy || \
  # If using docker:
  # docker compose up -d --build || \
  echo 'Done. Please restart the app manually if not using pm2/systemd/docker.'
"

echo ""
echo "=== Deployment Complete ==="
echo "Remote path: $REMOTE_PATH"
echo "Backups saved to /tmp on remote server"
echo ""
echo "Files deployed:"
echo "  - server/ (backend code)"
echo "  - dist/ (built frontend)"
echo "  - package*.json (dependencies)"
echo ""
echo "Files preserved (NOT overwritten):"
echo "  - .env (environment variables)"
echo "  - data/ (store.json and usage logs)"
