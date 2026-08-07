#!/bin/sh
# Render the Synapse production config from its template, substituting
# secrets/hostnames from infra/.env. Synapse cannot read environment
# variables, so this is how "secrets live only in .env on the server"
# extends to homeserver.yaml.
#
# Usage: sh render-homeserver.sh
# Output: infra/synapse/homeserver.prod.yaml (gitignored — never commit)
set -eu
umask 077

cd "$(dirname "$0")"

TEMPLATE=synapse/homeserver.prod.yaml.template
OUTPUT=synapse/homeserver.prod.yaml

[ -f .env ] || { echo "ERROR: infra/.env not found — create it from .env.example first." >&2; exit 1; }

# Load .env (values must not contain single quotes or newlines).
set -a
. ./.env
set +a

for var in SYNAPSE_SERVER_NAME SYNAPSE_DB_NAME SYNAPSE_DB_USER SYNAPSE_DB_PASSWORD MATRIX_PUBLIC_URL; do
  eval "value=\${$var:-}"
  [ -n "$value" ] || { echo "ERROR: $var is not set in infra/.env" >&2; exit 1; }
  # sed would silently mangle these in the replacement text.
  case "$value" in
    *'&'* | *'|'* | *'\'*)
      echo "ERROR: $var contains &, | or \\ — unsupported by this script; pick a value without them." >&2
      exit 1
      ;;
  esac
done

if [ "$SYNAPSE_SERVER_NAME" = "localhost" ]; then
  if [ "${GDM_ENV:-}" = "production" ]; then
    echo "ERROR: SYNAPSE_SERVER_NAME is 'localhost' with GDM_ENV=production." >&2
    echo "       server_name is immutable after Synapse's first start — fix infra/.env now." >&2
    exit 1
  fi
  echo "WARNING: SYNAPSE_SERVER_NAME is 'localhost' — fine locally, wrong in production." >&2
fi

OUTPUT_TMP=$(mktemp "${OUTPUT}.tmp.XXXXXX")
trap 'rm -f "$OUTPUT_TMP"' EXIT HUP INT TERM

sed \
  -e "s|\${SYNAPSE_SERVER_NAME}|$SYNAPSE_SERVER_NAME|g" \
  -e "s|\${SYNAPSE_DB_NAME}|$SYNAPSE_DB_NAME|g" \
  -e "s|\${SYNAPSE_DB_USER}|$SYNAPSE_DB_USER|g" \
  -e "s|\${SYNAPSE_DB_PASSWORD}|$SYNAPSE_DB_PASSWORD|g" \
  -e "s|\${MATRIX_PUBLIC_URL}|$MATRIX_PUBLIC_URL|g" \
  "$TEMPLATE" > "$OUTPUT_TMP"
chmod 600 "$OUTPUT_TMP"
mv "$OUTPUT_TMP" "$OUTPUT"
trap - EXIT HUP INT TERM

echo "Rendered $OUTPUT (server_name: $SYNAPSE_SERVER_NAME)"
