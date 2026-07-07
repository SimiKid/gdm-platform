#!/bin/sh
# Deploy or update the production stack. Runs ON the VM:
#
#   cd ~/gdm-platform && git pull && sh infra/deploy.sh
#
# Pulls the app images built by GitHub Actions from GHCR — nothing is built
# on the VM (keeps /var small). Pin a specific build for rollback:
#
#   IMAGE_TAG=<git-sha> sh infra/deploy.sh
#
# See docs/deployment.md for first-time setup, backup and troubleshooting.
set -eu

cd "$(dirname "$0")"

COMPOSE="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"

[ -f .env ] || { echo "ERROR: infra/.env not found — see docs/deployment.md (first-time setup)." >&2; exit 1; }
grep -q '^GDM_ENV=production' .env || {
  echo "ERROR: infra/.env does not set GDM_ENV=production — refusing to deploy a dev config." >&2
  exit 1
}

# Re-render the Synapse config so homeserver.prod.yaml matches .env and the
# template. Safe on every deploy: server_name changes only if .env changed
# (which must never happen after the first start — the render script warns).
sh render-homeserver.sh

echo "Pulling images (IMAGE_TAG=${IMAGE_TAG:-latest})..."
$COMPOSE pull

echo "Starting stack..."
$COMPOSE up -d --no-build --remove-orphans

# The VM has only 10 GB in /var — drop superseded image layers right away.
docker image prune -f

echo
$COMPOSE ps
echo
echo "Deployed. Verify: curl -fsS https://$(grep '^PUBLIC_HOST=' .env | cut -d= -f2)/api/health"
