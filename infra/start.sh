#!/bin/sh
set -eu

cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop first." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "No infra/.env found — creating one from .env.example (dev defaults)."
  cp .env.example .env
fi

echo "Stopping any existing GDM stack containers..."
docker compose --env-file .env down --remove-orphans

echo "Starting GDM stack..."
docker compose --env-file .env up --build
