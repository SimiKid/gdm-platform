#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
result_dir="${LOADTEST_RESULT_DIR:?LOADTEST_RESULT_DIR is required}"
interval="${LOADTEST_CANARY_INTERVAL_SECONDS:-600}"
initial_delay="${LOADTEST_CANARY_INITIAL_DELAY_SECONDS:-120}"

sleep "$initial_delay"
run_number=0

while true; do
  run_number=$((run_number + 1))
  log_file="$result_dir/browser-canary-$run_number.log"
  {
    printf 'Browser canary %s started at %s\n' "$run_number" "$(date -Iseconds)"
    E2E_PARTICIPANT_URL="$LOADTEST_BASE_URL" \
    E2E_SESSION_MANAGER_URL="${LOADTEST_BASE_URL%/}/api" \
    E2E_ADMIN_URL="${LOADTEST_BASE_URL%/}/admin/" \
    E2E_ADMIN_TOKEN="${LOADTEST_ADMIN_TOKEN:-}" \
      pnpm --dir "$repo_dir/e2e" exec playwright test tests/golden-path.spec.ts
  } >"$log_file" 2>&1 || true
  sleep "$interval"
done
