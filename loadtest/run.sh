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

profile="${1:-${LOADTEST_PROFILE:-smoke}}"
case "$profile" in
  smoke|step|spike|soak) ;;
  *)
    printf 'Unknown profile: %s\nUse: %s [smoke|step|spike|soak]\n' "$profile" "$0" >&2
    exit 2
    ;;
esac

export LOADTEST_PROFILE="$profile"
export LOADTEST_BASE_URL="${LOADTEST_BASE_URL:-https://gdmproject.ifi.uzh.ch}"
export LOADTEST_SSH_TARGET="${LOADTEST_SSH_TARGET:-masterproject}"
export LOADTEST_GROUP_SIZE="${LOADTEST_GROUP_SIZE:-3}"
export LOADTEST_SESSION_MINUTES="${LOADTEST_SESSION_MINUTES:-120}"
export LOADTEST_K6_IMAGE="${LOADTEST_K6_IMAGE:-grafana/k6:1.7.1}"
export LOADTEST_RUN_ID="${LOADTEST_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$profile}"
export LOADTEST_CONDITION_ID="${LOADTEST_CONDITION_ID:-e2e-load-$LOADTEST_RUN_ID}"
export LOADTEST_RESULT_DIR="${LOADTEST_RESULT_DIR:-$script_dir/results/$LOADTEST_RUN_ID}"

base_host="$(
  node -e 'process.stdout.write(new URL(process.argv[1]).hostname)' "$LOADTEST_BASE_URL"
)"
if [[ "$base_host" == "gdmproject.ifi.uzh.ch" ]] &&
   [[ "${LOADTEST_CONFIRM_PRODUCTION:-}" != "I_UNDERSTAND_THIS_WILL_CREATE_REAL_LOAD" ]]; then
  cat >&2 <<'EOF'
Refusing to load-test production without explicit confirmation.

Set this exact value in loadtest/.env after scheduling the run and confirming
that no real study session is active:

LOADTEST_CONFIRM_PRODUCTION=I_UNDERSTAND_THIS_WILL_CREATE_REAL_LOAD
EOF
  exit 3
fi

if [[ "$profile" != "smoke" ]] &&
   [[ "${LOADTEST_ALLOW_LARGE_PROFILE:-}" != "I_RAN_THE_SMOKE_TEST_FIRST" ]]; then
  cat >&2 <<EOF
Refusing to run the "$profile" profile before explicit smoke-test confirmation.

After the smoke result passes, set:

LOADTEST_ALLOW_LARGE_PROFILE=I_RAN_THE_SMOKE_TEST_FIRST
EOF
  exit 4
fi

for command in node curl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "$command" >&2
    exit 5
  fi
done

if [[ -z "${LOADTEST_ADMIN_TOKEN:-}" ]] && [[ "$base_host" != "localhost" ]] &&
   [[ "$base_host" != "127.0.0.1" ]]; then
  printf 'LOADTEST_ADMIN_TOKEN is required for a remote target.\n' >&2
  exit 6
fi

mkdir -p "$LOADTEST_RESULT_DIR"
chmod 755 "$LOADTEST_RESULT_DIR"

dashboard_pid=""
canary_pid=""
condition_created=0

cleanup() {
  exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "$canary_pid" ]]; then
    kill "$canary_pid" 2>/dev/null || true
    wait "$canary_pid" 2>/dev/null || true
  fi
  if [[ -n "$dashboard_pid" ]]; then
    kill "$dashboard_pid" 2>/dev/null || true
    wait "$dashboard_pid" 2>/dev/null || true
  fi
  if [[ "$condition_created" -eq 1 ]]; then
    node "$script_dir/scripts/condition.mjs" deactivate || true
  fi

  printf '\nResults: %s\n' "$LOADTEST_RESULT_DIR"
  if [[ -f "$LOADTEST_RESULT_DIR/k6-report.html" ]]; then
    printf 'HTML report: %s\n' "$LOADTEST_RESULT_DIR/k6-report.html"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

printf 'GDM load test\n'
printf '  target:    %s\n' "$LOADTEST_BASE_URL"
printf '  profile:   %s\n' "$LOADTEST_PROFILE"
printf '  run:       %s\n' "$LOADTEST_RUN_ID"
printf '  condition: %s\n' "$LOADTEST_CONDITION_ID"
printf '  results:   %s\n\n' "$LOADTEST_RESULT_DIR"

curl -fsS --max-time 10 "${LOADTEST_BASE_URL%/}/api/health" >/dev/null
curl -fsS --max-time 10 "${LOADTEST_BASE_URL%/}/_matrix/client/versions" >/dev/null

if [[ -n "${LOADTEST_SSH_TARGET:-}" ]]; then
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$LOADTEST_SSH_TARGET" \
    'docker ps --format "{{.Names}}" >/dev/null' >/dev/null

  running_sessions="$(
    ssh -o BatchMode=yes "$LOADTEST_SSH_TARGET" \
      "docker exec infra-research-db-1 psql -U gdm -d gdm_research -Atc \"select count(*) from sessions where status = 'running';\"" \
      2>/dev/null || printf 'unknown'
  )"
  if [[ "$running_sessions" =~ ^[0-9]+$ ]] && [[ "$running_sessions" -gt 0 ]] &&
     [[ "${LOADTEST_IGNORE_RUNNING_SESSIONS:-}" != "I_CONFIRMED_THEY_ARE_TEST_SESSIONS" ]]; then
    cat >&2 <<EOF
Refusing to start: production currently reports $running_sessions running session(s).
Wait for them to finish. If they are known test residue, set:

LOADTEST_IGNORE_RUNNING_SESSIONS=I_CONFIRMED_THEY_ARE_TEST_SESSIONS
EOF
    exit 7
  fi

  fd_limits="$(
    ssh -o BatchMode=yes "$LOADTEST_SSH_TARGET" 'for container in infra-caddy-1 infra-synapse-1; do printf "%s=" "$container"; docker exec "$container" sh -c "ulimit -n"; done'
  )"
  printf '%s\n' "$fd_limits" >"$LOADTEST_RESULT_DIR/file-descriptor-preflight.txt"
  minimum_fd_limit="$(
    printf '%s\n' "$fd_limits" | awk -F= 'NR == 1 || $2 < minimum { minimum=$2 } END { print minimum+0 }'
  )"
  if [[ "$minimum_fd_limit" -lt 4096 ]]; then
    if [[ "$profile" == "smoke" ]]; then
      printf 'Warning: server file-descriptor limit is %s; do not proceed to a large profile unchanged.\n' \
        "$minimum_fd_limit"
    elif [[ "${LOADTEST_IGNORE_LOW_FD_LIMIT:-}" != "I_ACCEPT_THE_DESCRIPTOR_CEILING" ]]; then
      cat >&2 <<EOF
Refusing the "$profile" profile: Caddy/Synapse file-descriptor limit is only
$minimum_fd_limit. Raise it to at least 4096 (preferably 65535), recreate the
containers, and rerun. To measure the known ceiling intentionally, set:

LOADTEST_IGNORE_LOW_FD_LIMIT=I_ACCEPT_THE_DESCRIPTOR_CEILING
EOF
      exit 8
    fi
  fi
fi

node "$script_dir/scripts/condition.mjs" create
condition_created=1

if [[ "${LOADTEST_MONITOR:-1}" == "1" ]] && [[ -n "${LOADTEST_SSH_TARGET:-}" ]]; then
  node "$script_dir/scripts/dashboard.mjs" \
    >"$LOADTEST_RESULT_DIR/system-dashboard.log" 2>&1 &
  dashboard_pid=$!
  sleep 1
  if ! kill -0 "$dashboard_pid" 2>/dev/null; then
    printf 'System dashboard failed to start:\n' >&2
    sed -n '1,120p' "$LOADTEST_RESULT_DIR/system-dashboard.log" >&2
    exit 9
  fi
  printf 'System dashboard: http://127.0.0.1:5666\n'
fi

if [[ "${LOADTEST_BROWSER_CANARY:-0}" == "1" ]]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    printf 'LOADTEST_BROWSER_CANARY=1 requires pnpm.\n' >&2
    exit 8
  fi
  "$script_dir/scripts/canary-loop.sh" &
  canary_pid=$!
  printf 'Browser canary: enabled (logs in the result directory)\n'
fi

printf 'k6 dashboard:     http://127.0.0.1:5665\n\n'
if [[ "${LOADTEST_OPEN_DASHBOARD:-1}" == "1" ]]; then
  (
    sleep 3
    dashboard_url="http://127.0.0.1:5665"
    if [[ "${LOADTEST_MONITOR:-1}" == "1" ]] && [[ -n "${LOADTEST_SSH_TARGET:-}" ]]; then
      dashboard_url="http://127.0.0.1:5666"
    fi
    if command -v open >/dev/null 2>&1; then
      open "$dashboard_url" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$dashboard_url" >/dev/null 2>&1 || true
    fi
  ) &
fi

common_env=(
  LOADTEST_BASE_URL
  LOADTEST_CONDITION_ID
  LOADTEST_RUN_ID
  LOADTEST_PROFILE
  LOADTEST_SYNC_TIMEOUT_MS
  LOADTEST_MESSAGE_MIN_SECONDS
  LOADTEST_MESSAGE_MAX_SECONDS
  LOADTEST_CURSOR_SECONDS
  LOADTEST_RANKING_MIN_SECONDS
  LOADTEST_RANKING_MAX_SECONDS
  LOADTEST_REACTION_MIN_SECONDS
  LOADTEST_REACTION_MAX_SECONDS
  LOADTEST_SLO_SEND_P95_MS
  LOADTEST_SLO_SEND_P99_MS
  LOADTEST_SLO_PEER_P95_MS
  LOADTEST_SLO_PEER_P99_MS
  LOADTEST_SLO_API_P95_MS
  LOADTEST_SLO_SESSION_OPEN_P95_MS
  LOADTEST_SLO_GROUP_READY_P95_MS
  LOADTEST_SLO_FAILURE_RATE
)

k6_env_args=()
for variable in "${common_env[@]}"; do
  if [[ -n "${!variable:-}" ]]; then
    k6_env_args+=(-e "$variable=${!variable}")
  fi
done

if command -v k6 >/dev/null 2>&1; then
  K6_WEB_DASHBOARD=true \
  K6_WEB_DASHBOARD_HOST=127.0.0.1 \
  K6_WEB_DASHBOARD_PORT=5665 \
  K6_WEB_DASHBOARD_PERIOD=5s \
  K6_WEB_DASHBOARD_EXPORT="$LOADTEST_RESULT_DIR/k6-report.html" \
    k6 run "${k6_env_args[@]}" \
      --summary-export "$LOADTEST_RESULT_DIR/summary.json" \
      "$script_dir/k6/participant.js" \
      2>&1 | tee "$LOADTEST_RESULT_DIR/k6.log"
else
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Neither k6 nor Docker is available.\n' >&2
    exit 8
  fi

  docker_base_url="$LOADTEST_BASE_URL"
  docker_base_url="${docker_base_url/localhost/host.docker.internal}"
  docker_base_url="${docker_base_url/127.0.0.1/host.docker.internal}"

  docker_env=(
    -e K6_WEB_DASHBOARD=true
    -e K6_WEB_DASHBOARD_HOST=0.0.0.0
    -e K6_WEB_DASHBOARD_PORT=5665
    -e K6_WEB_DASHBOARD_PERIOD=5s
    -e K6_WEB_DASHBOARD_EXPORT=/results/k6-report.html
  )
  for variable in "${common_env[@]}"; do
    if [[ -n "${!variable:-}" ]] && [[ "$variable" != "LOADTEST_BASE_URL" ]] &&
       [[ "$variable" != "LOADTEST_CONDITION_ID" ]] &&
       [[ "$variable" != "LOADTEST_RUN_ID" ]] &&
       [[ "$variable" != "LOADTEST_PROFILE" ]]; then
      docker_env+=(-e "$variable=${!variable}")
    fi
  done

  docker_k6_env_args=(
    -e "LOADTEST_BASE_URL=$docker_base_url"
    -e "LOADTEST_CONDITION_ID=$LOADTEST_CONDITION_ID"
    -e "LOADTEST_RUN_ID=$LOADTEST_RUN_ID"
    -e "LOADTEST_PROFILE=$LOADTEST_PROFILE"
  )
  for variable in "${common_env[@]}"; do
    if [[ -n "${!variable:-}" ]] && [[ "$variable" != "LOADTEST_BASE_URL" ]] &&
       [[ "$variable" != "LOADTEST_CONDITION_ID" ]] &&
       [[ "$variable" != "LOADTEST_RUN_ID" ]] &&
       [[ "$variable" != "LOADTEST_PROFILE" ]]; then
      docker_k6_env_args+=(-e "$variable=${!variable}")
    fi
  done

  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -p 127.0.0.1:5665:5665 \
    -v "$script_dir:/loadtest:ro" \
    -v "$LOADTEST_RESULT_DIR:/results" \
    "${docker_env[@]}" \
    "$LOADTEST_K6_IMAGE" \
    run "${docker_k6_env_args[@]}" \
      --summary-export /results/summary.json /loadtest/k6/participant.js \
    2>&1 | tee "$LOADTEST_RESULT_DIR/k6.log"
fi
