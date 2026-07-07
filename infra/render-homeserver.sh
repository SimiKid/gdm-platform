#!/bin/sh
# Render the Synapse production config from its template, substituting
# secrets/hostnames from infra/.env. Synapse cannot read environment
# variables, so this is how "secrets live only in .env on the server"
# extends to homeserver.yaml.
#
# Usage: sh render-homeserver.sh
# Output: infra/synapse/homeserver.prod.yaml (gitignored — never commit)
set -eu

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
done

if [ "$SYNAPSE_SERVER_NAME" = "localhost" ]; then
  echo "WARNING: SYNAPSE_SERVER_NAME is 'localhost' — fine locally, wrong in production." >&2
  echo "         server_name is immutable after Synapse's first start." >&2
fi

sed \
  -e "s|\${SYNAPSE_SERVER_NAME}|$SYNAPSE_SERVER_NAME|g" \
  -e "s|\${SYNAPSE_DB_NAME}|$SYNAPSE_DB_NAME|g" \
  -e "s|\${SYNAPSE_DB_USER}|$SYNAPSE_DB_USER|g" \
  -e "s|\${SYNAPSE_DB_PASSWORD}|$SYNAPSE_DB_PASSWORD|g" \
  -e "s|\${MATRIX_PUBLIC_URL}|$MATRIX_PUBLIC_URL|g" \
  "$TEMPLATE" > "$OUTPUT"

echo "Rendered $OUTPUT (server_name: $SYNAPSE_SERVER_NAME)"
