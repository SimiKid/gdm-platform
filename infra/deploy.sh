#!/bin/sh
# Deploy or update the production stack. Runs ON the VM:
#
#   cd ~/gdm-platform && git pull && sh infra/deploy.sh
#
# Pulls the app images built by GitHub Actions from GHCR — nothing is built
# on the VM (keeps /var small). Pin a specific build for rollback:
#
#   IMAGE_TAG=<short-sha> sh infra/deploy.sh   # 7-char sha, see Actions run
#
# See docs/deployment.md for first-time setup, backup and troubleshooting.
set -eu

cd "$(dirname "$0")"

COMPOSE="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"

[ -f .env ] || { echo "ERROR: infra/.env not found — see docs/deployment.md (first-time setup)." >&2; exit 1; }
chmod 600 .env
grep -q '^GDM_ENV=production' .env || {
  echo "ERROR: infra/.env does not set GDM_ENV=production — refusing to deploy a dev config." >&2
  exit 1
}

# Capture all persistent state before pulling an image whose entrypoint may run
# a forward-only Prisma migration. A partial/running-broken stack fails closed.
echo "Creating pre-deploy backup..."
sh backup.sh

# Re-render the Synapse config so homeserver.prod.yaml matches .env and the
# template. Safe on every deploy: server_name changes only if .env changed
# (which must never happen after the first start — the render script warns).
sh render-homeserver.sh
# Compose does not detect content changes inside bind-mounted files. Put the
# rendered config hash in a container label so `up` recreates Synapse exactly
# when its configuration changed (including rate-limit tuning).
SYNAPSE_CONFIG_SHA=$(sha256sum synapse/homeserver.prod.yaml | cut -d' ' -f1)
export SYNAPSE_CONFIG_SHA

echo "Pulling images (IMAGE_TAG=${IMAGE_TAG:-latest})..."
$COMPOSE pull

echo "Starting stack..."
$COMPOSE up -d --no-build --remove-orphans

echo "Waiting for application readiness..."
for service in research-db synapse-db synapse session-manager chat-service; do
  attempts=0
  while :; do
    container=$($COMPOSE ps -q "$service")
    [ -n "$container" ] || {
      echo "ERROR: $service has no running container" >&2
      $COMPOSE ps
      exit 1
    }
    service_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
    if [ "$service_status" = "healthy" ] || [ "$service_status" = "running" ]; then
      break
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 60 ]; then
      echo "ERROR: $service did not become ready (status=$service_status)" >&2
      $COMPOSE logs --tail=100 "$service"
      exit 1
    fi
    sleep 2
  done
done

# The VM has only 10 GB in /var — drop superseded image layers right away.
docker image prune -f

echo
$COMPOSE ps
echo
host=$(grep '^PUBLIC_HOST=' .env | cut -d= -f2)
curl -fsS "https://$host/api/health/ready" >/dev/null
echo "Deployed and ready: https://$host/api/health/ready"
