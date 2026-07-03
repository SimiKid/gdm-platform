#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Nothing to stop through Docker Compose." >&2
  exit 0
fi

if [ "${1:-}" = "--volumes" ]; then
  echo "Stopping GDM stack and removing Docker volumes..."
  docker compose --env-file .env down --remove-orphans --volumes
else
  echo "Stopping GDM stack..."
  docker compose --env-file .env down --remove-orphans
fi
