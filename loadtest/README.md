# GDM load-test harness

This directory is intentionally separate from the application workspaces. It
contains a protocol-level load generator, isolated test-condition lifecycle,
server monitoring, live dashboards, reports, and an optional real-browser
canary.

The harness exercises:

- participant frontend entry request;
- `POST /api/sessions` and waiting-room polling;
- entry-survey persistence;
- Matrix initial and incremental `/sync`;
- typing notifications and durable typing telemetry;
- chat messages with send-ack and peer-delivery measurements;
- cursor telemetry every ten seconds;
- reactions and shared-ranking edits (note: real participants can no longer
  send reactions — the UI removed them per study protocol — so the reaction
  traffic here is extra server-side load, not a model of production traffic;
  tune with `LOADTEST_REACTION_MIN/MAX_SECONDS`);
- Chat Service checkpoints and both PostgreSQL databases.

It does not need application dependencies. It uses a local `k6` binary when
available and otherwise runs the pinned official k6 Docker image.

## One-time setup

```bash
cp loadtest/.env.example loadtest/.env
```

Edit `loadtest/.env`:

1. Set `LOADTEST_ADMIN_TOKEN` to the server's `ADMIN_API_TOKEN`.
2. Verify `LOADTEST_SSH_TARGET=masterproject`.
3. Leave `LOADTEST_BROWSER_CANARY=0` for the first protocol-only smoke run;
   enable it for the diagnostic run if Playwright is installed.
4. For production only, set the exact confirmation value documented in the
   example file after scheduling a maintenance window.

Before a production test:

- obtain approval for intentional load on UZH infrastructure;
- make a database backup;
- verify no real participant session is running;
- preferably test a production-sized staging clone first;
- raise the file-descriptor limits before the 498/798 stages — the runner's
  preflight refuses to start when Caddy or Synapse report a limit below
  4,096 (see below).

## Run

From the repository root:

```bash
./loadtest/run.sh smoke
```

The command:

1. verifies the API, Matrix endpoint, SSH access, and absence of running
   sessions, and records the server file-descriptor limits;
2. creates a unique `e2e-load-*` condition with baseline rules and LLM disabled;
3. starts the system dashboard at <http://127.0.0.1:5666>;
4. starts the k6 dashboard at <http://127.0.0.1:5665>;
5. executes the selected profile;
6. writes all results below `loadtest/results/<run-id>/`;
7. deactivates the condition even if the test fails or is interrupted.

After the smoke test passes, acknowledge it in `.env`:

```dotenv
LOADTEST_ALLOW_LARGE_PROFILE=I_RAN_THE_SMOKE_TEST_FIRST
```

For the infrastructure evidence requested by the system administrator, run:

```bash
./loadtest/run.sh diagnostic
```

This profile ramps to and holds 30, 99 and 249 participants, then stops. It
continues collecting after ordinary SLO failures so the report contains the
resource state at the point of degradation. A separate 25% protocol-failure
emergency threshold still aborts a broad platform collapse.

Use `step` only when intentionally testing beyond 249 participants:

```bash
./loadtest/run.sh step
```

The 498/798-user profiles refuse to start if Caddy or Synapse still has fewer
than 4,096 file descriptors. Raising the deployment to 65,535 is recommended;
the refusal can be overridden only with the explicit value printed by the
runner when intentionally testing the known ceiling. The 249-user diagnostic
profile records the existing limit in its evidence bundle and emits a warning,
but deliberately preserves the current VM configuration for the baseline.

Available profiles:

| Profile | Purpose |
|---|---|
| `smoke` | 30 users for five minutes |
| `diagnostic` | 30 → 99 → 249, with stable evidence plateaus and no ordinary SLO abort |
| `step` | 30 → 99 → 249 → 498 → 798 |
| `spike` | 30 → 798 in one minute; run only after `step` |
| `soak` | 498 users for one hour |

Targets are divisible by the production group size of three so no virtual
participants remain indefinitely in a partial group.

## Dashboards and results

The system dashboard samples the deployment over SSH at the configured
interval (ten seconds is recommended for diagnostic runs):

- host and per-core CPU (user/system/busy/idle/I/O-wait/steal), Linux load,
  memory, swap, Pressure Stall Information, network rates and TCP connections;
- disk throughput, IOPS, utilization, queue size, read/write await time and
  I/O pressure;
- CPU, RSS, read rate and write rate for the highest-resource processes in
  every container;
- CPU, memory, network rates, block-I/O rates and PIDs for every container;
- file-descriptor usage and limits for Caddy, Synapse, Session Manager, and
  Chat Service;
- PostgreSQL connections, transactions, cache hit ratio, temporary writes,
  long-running activity and wait events.

Counter-based rates are calculated between samples. This avoids treating
cumulative Docker block-I/O totals as current pressure and does not require
`mpstat`, `pidstat` or `iostat` to be installed on the VM.

k6's dashboard shows virtual users, request rate, checks, custom latency
trends, HTTP failures, and thresholds. It exports a self-contained
`k6-report.html`.

Each run directory contains:

- `run-metadata.json`
- `summary.json`
- `k6.log`
- `k6-report.html`
- `server-metrics.jsonl`
- `system-dashboard.log`
- optional `browser-canary-*.log`
- `file-descriptor-preflight.txt` (on SSH-enabled runs)

At the end of every monitored run, `scripts/report.mjs` also generates:

- `diagnostic-report.html` — the primary report to send or print to PDF;
- `diagnostic-report.md` — a text-friendly equivalent;
- `diagnostic-summary.json` — all derived stage summaries;
- stage, CPU-core, container, process, disk and database CSV files;
- `share-with-admin/` — a self-contained evidence bundle containing the
  reports, CSVs, raw k6/system metrics, preflight configuration, canary logs
  and SHA-256 checksums.
- `gdm-diagnostic-evidence-<run-id>.tar.gz` — the same evidence bundle as one
  attachment suitable for sending to the system administrator.

The report separates stable 30/99/249 holds, excludes the first 20 seconds of
each hold, lists the highest-resource services/processes, and explains exactly
how every metric was obtained. Open it with:

```bash
open loadtest/results/<run-id>/diagnostic-report.html
```

The most important custom metrics are:

- `session_open_ms`
- `group_ready_ms`
- `matrix_initial_sync_ms`
- `matrix_send_ack_ms`
- `matrix_own_delivery_ms`
- `matrix_peer_delivery_ms`
- `protocol_failure_rate`
- `http_429_count`
- `http_5xx_count`

Matrix `/sync` is a deliberate long-poll. Its HTTP duration is not used as a
responsiveness threshold; message delivery time is measured from a timestamped
load-test message until another participant observes that event through sync.

## Optional real-browser canary

Set:

```dotenv
LOADTEST_BROWSER_CANARY=1
```

The runner will periodically execute the repository's existing three-browser
golden-path test against the target while protocol load is active. This checks
that the actual participant UI remains usable without attempting to run
hundreds of Chromium processes. The e2e package and Playwright browser must
already be installed:

```bash
pnpm install
pnpm --dir e2e exec playwright install chromium
```

Canary failures are recorded but do not terminate the capacity test.

## Standalone server monitor

The monitoring dashboard can be run without generating traffic:

```bash
./loadtest/monitor.sh
```

Stop it with `Ctrl-C`.

## Safety and test residue

- Only condition IDs beginning with `e2e-load-` are accepted.
- LLM mode is always `off`.
- The runner never deletes research or Matrix data.
- The condition is deactivated after the run.
- `e2e-*` sessions are excluded from research exports by the application.
- Load sessions are stamped with the currently open **study round** like any
  other session. They never appear in exports (previous point), but they are
  visible in the rounds' session counts on a live study dashboard.
- Rooms and Matrix users remain as test residue. Use a disposable staging
  database for repeated high-load runs.
- `LOADTEST_SESSION_MINUTES` controls when the server-side Chat Service
  finalizes rooms. The default is deliberately longer than the progressive
  profile so rooms do not expire midway through the test.
- `LOADTEST_ENROLL_BACKOFF_BASE_SECONDS` and
  `LOADTEST_ENROLL_BACKOFF_MAX_SECONDS` bound exponential per-participant retry
  jitter after a failed enrollment. Failures still remain visible in k6; the
  backoff only prevents them from turning into a synchronized retry storm.

An interrupted load test may leave Chat Service runtimes alive until their
configured duration expires. This is another reason to use a staging clone for
the 498/798 profiles.
