#!/bin/sh
# Consistent pre-deploy backups of both databases and Synapse's file volume.
set -eu

cd "$(dirname "$0")"
umask 077

[ -f .env ] || { echo "ERROR: infra/.env not found" >&2; exit 1; }
set -a
# Production .env is administrator-controlled and already consumed by Compose.
. ./.env
set +a

COMPOSE="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"
BACKUP_DIR=${BACKUP_DIR:-"$(pwd)/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

research_container=$($COMPOSE ps -q research-db)
synapse_db_container=$($COMPOSE ps -q synapse-db)
synapse_container=$($COMPOSE ps -q synapse)

if [ -z "$research_container" ] && [ -z "$synapse_db_container" ]; then
  echo "No running databases found; treating this as an initial deployment."
  exit 0
fi
if [ -z "$research_container" ] || [ -z "$synapse_db_container" ] || [ -z "$synapse_container" ]; then
  echo "ERROR: only part of the persistent stack is running; refusing an incomplete backup." >&2
  exit 1
fi

research="$BACKUP_DIR/research-$timestamp.dump"
synapse_db="$BACKUP_DIR/synapse-db-$timestamp.dump"
synapse_data="$BACKUP_DIR/synapse-data-$timestamp.tar.gz"
checksum="$BACKUP_DIR/checksums-$timestamp.sha256"

cleanup() {
  rm -f "$research.tmp" "$synapse_db.tmp" "$synapse_data.tmp" "$checksum.tmp"
}
trap cleanup EXIT HUP INT TERM

echo "Backing up research database..."
$COMPOSE exec -T research-db \
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    -U "$RESEARCH_DB_USER" "$RESEARCH_DB_NAME" > "$research.tmp"
[ -s "$research.tmp" ]
$COMPOSE exec -T research-db pg_restore --list < "$research.tmp" >/dev/null
mv "$research.tmp" "$research"

echo "Backing up Synapse database..."
$COMPOSE exec -T synapse-db \
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    -U "$SYNAPSE_DB_USER" "$SYNAPSE_DB_NAME" > "$synapse_db.tmp"
[ -s "$synapse_db.tmp" ]
$COMPOSE exec -T synapse-db pg_restore --list < "$synapse_db.tmp" >/dev/null
mv "$synapse_db.tmp" "$synapse_db"

echo "Backing up Synapse signing key/media volume..."
$COMPOSE exec -T synapse tar -C /data -czf - . > "$synapse_data.tmp"
gzip -t "$synapse_data.tmp"
mv "$synapse_data.tmp" "$synapse_data"

(
  cd "$BACKUP_DIR"
  sha256sum "$(basename "$research")" "$(basename "$synapse_db")" \
    "$(basename "$synapse_data")"
) > "$checksum.tmp"
mv "$checksum.tmp" "$checksum"

trap - EXIT HUP INT TERM

echo "Backup complete: $BACKUP_DIR (*-$timestamp.*)"
echo "Copy this backup set off the VM; local retention is intentionally not automated."
