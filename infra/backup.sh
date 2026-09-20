#!/bin/sh
# Pre-deploy backups of the research, Synapse and Etherpad databases and Synapse's file volume.
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
etherpad_container=$($COMPOSE ps -a -q etherpad-db)

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
etherpad_db="$BACKUP_DIR/etherpad-db-$timestamp.dump"
checksum="$BACKUP_DIR/checksums-$timestamp.sha256"

cleanup() {
  rm -f "$research.tmp" "$synapse_db.tmp" "$synapse_data.tmp" "$etherpad_db.tmp" "$checksum.tmp"
}
trap cleanup EXIT HUP INT TERM

echo "Backing up research database..."
$COMPOSE exec -T research-db \
  pg_dump --format=custom --compress=9 --no-owner --no-privileges \
    -U "$RESEARCH_DB_USER" "$RESEARCH_DB_NAME" > "$research.tmp"
[ -s "$research.tmp" ]
$COMPOSE exec -T research-db pg_restore --list < "$research.tmp" >/dev/null
mv "$research.tmp" "$research"

# Older deployments have no Etherpad database yet. Once created, require its
# backup even when the editor itself is switched off.
if [ -n "$etherpad_container" ]; then
  echo "Backing up Etherpad database..."
  $COMPOSE exec -T etherpad-db \
    pg_dump --format=custom --compress=9 --no-owner --no-privileges \
      -U etherpad etherpad > "$etherpad_db.tmp"
  [ -s "$etherpad_db.tmp" ]
  $COMPOSE exec -T etherpad-db pg_restore --list < "$etherpad_db.tmp" >/dev/null
  mv "$etherpad_db.tmp" "$etherpad_db"
fi

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
  if [ -f "$etherpad_db" ]; then sha256sum "$(basename "$etherpad_db")"; fi
) > "$checksum.tmp"
mv "$checksum.tmp" "$checksum"

trap - EXIT HUP INT TERM

echo "Backup complete: $BACKUP_DIR (*-$timestamp.*)"
echo "Copy this backup set off the VM; local retention is intentionally not automated."
