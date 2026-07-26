#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="${LOADTEST_ENV_FILE:-$script_dir/.env}"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

export LOADTEST_RUN_ID="${LOADTEST_RUN_ID:-standalone-monitor}"
export LOADTEST_PROFILE="${LOADTEST_PROFILE:-monitor-only}"
export LOADTEST_CONDITION_ID="${LOADTEST_CONDITION_ID:-none}"
export LOADTEST_RESULT_DIR="${LOADTEST_RESULT_DIR:-$script_dir/results/$LOADTEST_RUN_ID}"

mkdir -p "$LOADTEST_RESULT_DIR"
exec node "$script_dir/scripts/dashboard.mjs"
