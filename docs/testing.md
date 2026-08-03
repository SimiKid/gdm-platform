# Testing

How the test suite is organized, what each layer covers, and how to run it.

## Strategy: Three Layers

The suite follows a pyramid. Each layer fakes as little as possible for what it
verifies, and each real external system (Postgres, Synapse, the browser) is
exercised by exactly one layer so failures point somewhere specific.

| Layer | Command | Needs | Runtime | What is real |
|---|---|---|---|---|
| Unit | `pnpm test` | Node | seconds | Pure logic, components in jsdom |
| Integration | `pnpm test:integration` | Docker | ~1 min | Nest apps over HTTP, Postgres, Synapse |
| End-to-end | `pnpm test:e2e` | Running compose stack | ~2 min | Everything: browsers, all services, Matrix |

All commands work from the repo root (they fan out via `pnpm -r`) or inside a
single package.

## Unit Tests (`src/**/*.spec.ts`)

Fast, no network, no containers. They own the pure logic:

- **`bot-rules.spec.ts`** — the intervention engine (contribution scoring,
  thresholds, protected windows, generated wording integration and fallbacks).
  This is the scientific core; keep its coverage rich.
- **`session-runtime.spec.ts`** — the per-room state machine (messages,
  reactions, redactions, ranking history).
- **`sessions.service.spec.ts`** (both services) — matchmaking and event
  handling against hand-rolled fakes.
- **Frontend component specs** — Testing Library flows for the survey pages
  (`Survey.spec.tsx` drives consent → ranking → follow-ups end to end).

Conventions:

- Unit tests construct services by hand and fake only the Matrix/HTTP boundary.
  Assert on behavior (what was recorded, posted, returned) — not on request
  URLs or headers; wire formats belong to the integration layer.
- Coverage gates run via `pnpm test:cov`. Files whose main body is only
  exercised by another layer are excluded from the unit metrics with a comment
  saying which layer owns them (e.g. `store.service.ts` → integration suite;
  the Matrix-driven frontend components → e2e).

## Integration Tests (`test/integration/*.integration.spec.ts`)

Each backend boots its real NestJS module graph and is driven through real
HTTP (supertest). Infrastructure comes from
[Testcontainers](https://node.testcontainers.org/) — Docker must be running;
each run starts throwaway containers and removes them afterwards.

### session-manager (`backend/session-manager/test/integration/`)

- **Real:** the whole app, `StoreService` in Postgres mode, a `postgres:16`
  container with the actual Prisma migrations applied.
- **Faked:** Synapse (`FakeMatrixService`) and the Chat Service (a fetch
  recorder). Any other outbound network call fails the test.
- **Covers:** condition seeding, seat-by-seat matchmaking and provisioning,
  the concurrent-join race (simultaneous joiners must land in one group),
  404/409 paths, the finalize → Postgres → read-back round-trip **across app
  restarts** (a fresh app instance can only answer from the database), survey
  upserts, settings, CSV export escaping and filtering.

### chat-service (`backend/chat-service/test/integration/`)

- **Real:** the whole app including the bot's Matrix registration, its
  long-poll `/sync` loop and `ContributionBotRules`, against a real
  `matrixdotorg/synapse` container (SQLite-backed, rate limits disabled,
  config generated in `global-setup.ts`).
- **Faked:** the Session Manager — a local `node:http` recorder that captures
  the finalize callback.
- **Covers:** room takeover on `POST /internal/sessions/start`, event
  collection through real sync (messages, reactions, redactions, `de.gdm.ranking`),
  the server-side discussion timer, and the nudge behavior per condition:
  baseline stays silent, public nudges fire exactly once per intervention
  window, private nudges carry the `de.gdm.recipient` key.

### Conventions

- Separate config: `vitest.config.integration.ts` per package, so `pnpm test`
  stays fast. Integration files never match the unit glob.
- These configs compile with SWC instead of esbuild: booting the real Nest
  module graph requires `emitDecoratorMetadata`, which esbuild cannot emit.
  (Unit tests don't notice because they construct services by hand.)
- One container per run (vitest `globalSetup`), state wiped between tests.
- Timers under test are driven by small real durations (fractional
  `durationMinutes` in the start notification), not fake timers — the point
  is the real event loop.

## End-to-End (`e2e/`)

The default Playwright profile covers the complete three-participant journey,
validation feedback, live typing and reactions, shared ranking and panel
resizing, behavioral telemetry, every intervention mode, the admin download,
and all JSON/CSV export families. API-provisioned scenarios jump directly into
the real Matrix chat so only the golden path waits for the one-minute timer.

```bash
cd infra && sh start.sh     # the stack must be up; global-setup fails fast if not
pnpm test:e2e
```

Two disruptive or externally billed profiles are opt-in:

```bash
# Three real classifications through the deployed Anthropic integration.
pnpm --dir e2e test:e2e:live

# Local compose only: stops and starts Session Manager + Chat Service in order.
E2E_COMPOSE_ENV_FILE=.env pnpm --dir e2e test:e2e:recovery
```

The restart profile refuses non-local API URLs and refuses to run while a
non-E2E session is waiting or running. The live profile is intentionally one
test; it verifies the four meaningfulness indicators and pseudonymized
prompts on a baseline condition, where no nudge may ever render.

First-time setup: `pnpm --filter @gdm/e2e exec playwright install chromium`.

Notes:

- Each run creates its own disposable condition (`e2e-<timestamp>`, baseline
  mode, 1-minute discussion) and deactivates it afterwards, so runs never
  touch the real study arms and stale sessions from an aborted run can't soak
  up participants. Test rows remain in the research DB; wipe with
  `sh stop.sh --volumes` when you want a clean slate.
- Discussion durations must be **whole minutes**: the research DB stores
  `durationMinutes` as an integer and silently truncates fractions to 0
  (instant session end, no client timer).
- On failure, Playwright saves a trace:
  `pnpm --filter @gdm/e2e exec playwright show-trace test-results/<run>/trace.zip`.
- The e2e tests the images the stack is running — rebuild after backend
  changes (`docker compose up -d --build session-manager chat-service`).
- The suite can target any deployed stack: `E2E_PARTICIPANT_URL`,
  `E2E_SESSION_MANAGER_URL` and `E2E_ADMIN_URL` override the localhost
  defaults, and `E2E_ADMIN_TOKEN` authenticates against a stack whose
  `ADMIN_API_TOKEN` is set (attached as `x-admin-token` to API calls and
  pre-seeded into the dashboard's localStorage). See the smoke-test section
  in [deployment.md](deployment.md) for the ready-made production command.
- Keep the full suite at one worker. For a deliberate load probe, target only
  `tests/golden-path.spec.ts` with `--repeat-each=N --workers=W`; each worker
  provisions its own condition, so concurrent sessions cannot cross-match.

## Which Layer Does a New Test Belong In?

1. **Pure logic or a single component?** Unit. Fake the boundary, assert
   behavior.
2. **Depends on SQL, Prisma mapping, HTTP routing/status codes, or real
   Matrix semantics (sync, redactions, room membership)?** Integration, in
   the owning service.
3. **Spans services or needs a real browser (matrix-js-sdk client, timers
   driving UI transitions)?** e2e — but keep it to golden paths; edge cases
   belong lower in the pyramid.

Bugs found by a higher layer should be pinned by a test at the lowest layer
that can reproduce them (e.g. the concurrent-join race found by e2e is pinned
by a session-manager integration test).
