#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop first." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing infra/.env." >&2
  exit 1
fi

echo "Stopping any existing GDM stack containers..."
docker compose --env-file .env down --remove-orphans

echo "Starting GDM stack..."
docker compose --env-file .env up --build
