# Testing

How the test suite is organized, what each layer covers, and how to run it.

## Strategy: Three Layers

The suite follows a pyramid. Each layer fakes as little as possible for what it
verifies, and each real external system (Postgres, Synapse, the browser) is
exercised by exactly one layer so failures point somewhere specific.

| Layer | Command | Needs | Runtime | What is real |
|---|---|---|---|---|
| Unit | `pnpm test` | Node | seconds | Pure logic, participant and admin-dashboard components in jsdom |
| Integration | `pnpm test:integration` | Docker | minutes (real timers + two container runs) | Nest apps over HTTP, Postgres, Synapse |
| End-to-end | `pnpm test:e2e` | Running compose stack | a few minutes (the golden path waits for a real one-minute discussion) | Everything: browsers, all services, Matrix |

All commands work from the repo root (they fan out via `pnpm -r`) or inside a
single package.

## Unit Tests (`src/**/*.spec.ts`, `src/**/*.spec.tsx` in the frontend)

Fast, no network, no containers. They own the pure logic:

- **`bot-rules.spec.ts`** — the intervention engine (contribution scoring,
  thresholds, protected windows, generated wording integration and fallbacks,
  the `llmMode: "active"` composite dominance score, and the `LLM_MODE` env
  override). This is the scientific core; keep its coverage rich.
- **`session-runtime.spec.ts`** — the per-room state machine (messages,
  reactions, redactions, ranking history); plus classifier, nudge-generator,
  Matrix-bot and internal-guard specs
  (`anthropic-contribution-classifier.spec.ts`,
  `anthropic-nudge-message-generator.spec.ts`, `matrix-bot.service.spec.ts`,
  `auth/internal.guard.spec.ts`).
- **`sessions.service.spec.ts` / controller specs** (both services) —
  matchmaking and event handling against hand-rolled fakes. The session
  manager additionally has specs for its guards (`auth/guards.spec.ts`), the
  Matrix client (`matrix/matrix.service.spec.ts`), Prolific actions
  (`prolific/prolific-actions.service.spec.ts`), request validation and body
  limits (`validation/request-validation.spec.ts`, `request-body.spec.ts`),
  and a small store spec (`store/store.service.spec.ts`) for the pure
  normalization helpers.
- **Reports/analysis specs** (`backend/session-manager/src/reports/`) —
  pseudonymization, NASA scoring, equality metrics, and the report service.
- **Frontend component specs** — Testing Library flows for the participant
  pages (`Survey.spec.tsx` walks consent → about you → attitudes → task →
  group phase; `App`, `AboutYouPage`, `Chat`, `SharedRanking`,
  `ExternalWorkspace`, `Recruiting`, `ExitSurvey`, `DebriefingPage`,
  `StudyExitPage`, `RankingBoard`, and the `src/study/` helpers have their
  own specs) and for the admin dashboard (`App` with its token gate,
  `Overview`, `Results`, `Settings`, `ProlificOutcomes`, `Testing`,
  `AuthenticatedDownloadLink`, and `api.ts`). Dashboard specs stub `fetch`
  with a path → response table (`src/test-utils.ts`) so each assertion reads
  as "this click sends this request".

Conventions:

- Unit tests construct services by hand and fake only the Matrix/HTTP boundary.
  Assert on behavior (what was recorded, posted, returned) — not on request
  URLs or headers; wire formats belong to the integration layer.
- Coverage gates run via `pnpm test:cov` (80 % lines/functions/statements,
  70 % branches in both backends and both frontends). CI runs `pnpm test:cov`, not `pnpm test`,
  on every pull request to `main` and every push to `main`, so a drop below a
  threshold fails the `verify` job. In the session manager, files whose main
  body is only exercised by another layer are excluded from the unit metrics
  with a comment saying which layer owns them (`store.service.ts` and
  `prisma.service.ts` → integration suite); the chat service only excludes
  `main.ts`, the Nest modules and the spec files themselves. The participant
  frontend measures all of `src/` except three files owned by the e2e suite,
  each named in the config with the reason: `App.tsx` (wires the whole flow
  together), `WaitingRoom.tsx` (boots a real Matrix client against Synapse)
  and `DinoGame.tsx` (a canvas/`requestAnimationFrame` loop with no study
  logic). Everything else — the survey pages, chat, shared ranking, the
  ranking board and the study helpers — counts toward the gate.

## Integration Tests (`test/integration/*.integration.spec.ts`)

Each backend boots its real NestJS module graph and is driven through real
HTTP (supertest). Infrastructure comes from
[Testcontainers](https://node.testcontainers.org/) — Docker must be running;
each run starts throwaway containers and removes them afterwards.

### session-manager (`backend/session-manager/test/integration/`)

- **Real:** the whole app, `StoreService` in Postgres mode, a
  `postgres:16-alpine` container with the actual Prisma migrations applied.
- **Faked:** Synapse (`FakeMatrixService`) and the Chat Service (a fetch
  recorder). Any other outbound network call fails the test.
- **Covers:** condition seeding, seat-by-seat matchmaking and provisioning,
  least-claimed condition assignment, the concurrent-join race (simultaneous
  joiners must land in one group), 404/409 paths, seat credentials being
  required on participant endpoints, aborted Prolific submissions staying
  terminal, the finalize → Postgres → read-back round-trip **across app
  restarts** (a fresh app instance can only answer from the database),
  partial/retried checkpoint merges, monotonic reaction redactions, survey
  upserts and token/survey leak protection, token rejoin on refresh, Prolific
  arrival/identity/completion persistence, stale-heartbeat timeouts releasing
  a seat, condition edits surviving restarts, oversized (>100 KB)
  checkpoints, settings, CSV export escaping and filtering, **study rounds**
  (start aborts lobbies, resets progress, round-scopes matchmaking), and the
  reports suite (`reports.integration.spec.ts`: window evaluations and
  classification failures across restart, old-checkpoint compatibility,
  pseudonymized `participants.csv` + `linkage.csv`, `roundIds`/`conditionIds`
  filtering, and the research ZIP with codebook and no linkage file).

### chat-service (`backend/chat-service/test/integration/`)

- **Real:** the whole app including the bot's Matrix registration, its
  long-poll `/sync` loop and `ContributionBotRules`, against a real
  `matrixdotorg/synapse:v1.157.2` container (override with
  `SYNAPSE_TEST_IMAGE`; SQLite-backed, rate limits disabled, config generated
  in `global-setup.ts`).
- **Faked:** the Session Manager — a local `node:http` recorder that captures
  the finalize callback.
- **Covers:** room takeover on `POST /internal/sessions/start`, event
  collection through real sync (messages, reactions, redactions, `de.gdm.ranking`),
  backfill of messages sent while the recorder was down, the server-side
  discussion timer, the nudge behavior per condition (baseline stays silent,
  public nudges fire exactly once per intervention window, private nudges
  carry the `de.gdm.recipient` key).

### Conventions

- Separate config: `vitest.config.integration.ts` per package, so `pnpm test`
  stays fast. Integration files never match the unit glob.
- These configs compile with SWC instead of esbuild: booting the real Nest
  module graph requires `emitDecoratorMetadata`, which esbuild cannot emit.
  (Unit tests don't notice because they construct services by hand.)
- One container per run (vitest `globalSetup`). The session-manager harness
  truncates the database before every test; the chat-service tests share one
  Synapse and isolate themselves by creating fresh users and rooms.
- Timers under test are driven by small real durations (fractional
  `durationMinutes` in the start notification), not fake timers — the point
  is the real event loop.

## End-to-End (`e2e/`)

The default Playwright run covers the complete three-participant journey,
validation feedback, live typing (and asserting that emoji reactions are
**absent**, per the turn-taking design), shared ranking and panel resizing,
behavioral telemetry, both delivery modes (public/private — the detection
axis is only exercised by the opt-in live spec), the Results dashboard
(`results-dashboard.spec.ts`: descriptives, round-filter chips rewriting
every download link, the research-bundle ZIP, and the Study Rounds
confirm/cancel step), the admin download, and all JSON/CSV export families
including `roundIds`×`conditionIds` composition. The 401 guards on
`linkage.csv`/`research.zip` are asserted only when `E2E_ADMIN_TOKEN` is
set, i.e. against a token-protected stack, not in the default local run.
API-provisioned scenarios jump directly into the real Matrix chat so only the
golden path waits for the one-minute timer.

```bash
cd infra && sh start.sh     # the stack must be up; global-setup fails fast if not
pnpm test:e2e
```

Two disruptive or externally billed specs are opt-in. They are collected by
the default run too but **self-skip** unless their env gate is set
(`E2E_LIVE_ANTHROPIC` / `E2E_ALLOW_SERVICE_RESTART`); the dedicated scripts
just set the gate and narrow the file list:

```bash
# Three real classifications through the deployed Anthropic integration.
pnpm --dir e2e test:e2e:live

# Local compose only: stops and starts Session Manager + Chat Service in order.
pnpm --dir e2e test:e2e:recovery
```

The restart profile refuses non-local API URLs and refuses to run while a
non-E2E session is waiting or running. The live profile is intentionally one
test; it verifies the four meaningfulness indicators and pseudonymized
prompts on a baseline condition, where no nudge may ever render.

First-time setup: `pnpm --filter @gdm/e2e exec playwright install chromium`.

Notes:

- Specs create their own disposable `e2e-…` conditions and deactivate them
  afterwards (the shared helper defaults to a 2-minute discussion and group
  size 2 under a per-spec prefix such as `e2e-exports-…` or
  `e2e-intervention-public-…`, falling back to `e2e-condition-…`; the
  recovery spec uses 3 minutes; the golden path uses `e2e-<timestamp>` with 1
  minute and group size 3; `results-dashboard.spec.ts` is read-only and
  creates none), so runs never touch the real study arms and stale sessions
  from an aborted run can't soak up participants. Test rows remain in the research DB; wipe with
  `sh stop.sh --volumes` when you want a clean slate.
- Discussion durations must be **whole minutes**: the research DB stores
  `durationMinutes` as an integer and the session manager rounds and clamps
  every condition write to 1–240 (`0.25` becomes `1`, `1.5` becomes `2`), so
  a fractional value silently runs a different discussion length than the
  test intended. (Fractional minutes are only honoured by the chat-service
  integration harness, which bypasses the session manager.)
- On failure, Playwright saves a trace:
  `pnpm --filter @gdm/e2e exec playwright show-trace test-results/<run>/trace.zip`.
- The e2e tests the images the stack is running — rebuild after backend
  changes (`docker compose up -d --build session-manager chat-service`).
- The suite can target any deployed stack: `E2E_PARTICIPANT_URL`,
  `E2E_SESSION_MANAGER_URL` and `E2E_ADMIN_URL` override the localhost
  defaults, and `E2E_ADMIN_TOKEN` authenticates against a stack whose
  `ADMIN_API_TOKEN` is set (attached as an `Authorization: Bearer` credential
  to API calls and pre-seeded into the dashboard's `sessionStorage` under
  `gdm-admin-token`, from where the dashboard migrates it into
  `localStorage`). See the smoke-test section in [deployment.md](deployment.md)
  for the ready-made production command.
- Keep the full suite at one worker (`workers: 1`, `fullyParallel: false` in
  `playwright.config.ts`; 5-minute per-test timeout). For a deliberate load
  probe, target only `tests/golden-path.spec.ts` with
  `--repeat-each=N --workers=W`; each worker process derives its condition id
  from its start time (`e2e-<timestamp>`), so concurrent sessions cannot
  cross-match.

## Demo script (not a test)

`e2e/scripts/run-demo-discussions.mjs` drives 9 isolated browser contexts
(one Chromium process) through the full participant flow as 3 parallel
groups of 3 (arms `baseline`,
`public-llm`, `private-llm`) with the real 3-minute warm-up and 10-minute
discussion (~13 min total). Use it to generate realistic demo data or to
eyeball the bots live:

```bash
cd e2e && node scripts/run-demo-discussions.mjs
```

It is not part of any Playwright run (`pnpm --dir e2e test:e2e:list` shows
what is).

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
