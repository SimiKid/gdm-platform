# Getting Started

How to run the GDM platform locally for development and pilot testing.

## Prerequisites

- **Docker Desktop** (or Docker Engine + Compose plugin) running on your machine
- No host-level Node.js or pnpm installation is required for running the app stack
- For running tests or Prisma commands locally: Node.js 22+ (the Docker images use `node:22-alpine`) and `corepack prepare pnpm@11.8.0 --activate`

## Start the Stack

```bash
cd infra
sh start.sh
```

This builds and starts all services via Docker Compose. On first run, expect a longer build as Docker pulls base images and compiles the backends.

Alternatively, run directly (`.env` is gitignored — on a fresh clone create it first):

```bash
cd infra
cp .env.example .env   # only needed once; start.sh does this for you
docker compose --env-file .env up --build
```

## Stop the Stack

```bash
cd infra
sh stop.sh              # stop containers, keep data
sh stop.sh --volumes    # stop containers and wipe all data (clean slate)
```

## Services and Ports

| Service | URL | Description |
|---|---|---|
| Participant frontend | http://localhost:3000 | The study UI participants interact with |
| Admin dashboard | http://localhost:3003 | Researcher-facing condition management and exports |
| Session Manager API | http://localhost:3001/api | Backend REST API for sessions, conditions, surveys, Prolific, exports |
| Chat Service | http://localhost:3002 | Bot runtime that monitors Matrix rooms |
| Synapse (Matrix) | http://localhost:8010 | Matrix homeserver (`SYNAPSE_HTTP_PORT`; the compose fallback when the variable is unset is 8008) |
| Research Postgres | `localhost:5433` | Study data (sessions, surveys, interventions) |

The participant frontend's nginx reverse-proxies `/api/` to the session manager and `/_matrix/` to Synapse, so the browser only talks to `localhost:3000`.

## Running a Pilot Session

### 1. Open the admin dashboard

Go to http://localhost:3003. The dashboard has four tabs: **Prolific** (participant outcomes and compensation actions), **Overview** (progress, session list with the per-session inspector, study link, Export Data card), **Settings** (recruiting, study rounds, shared parameters, shared workspace, completion/exit paths), and **Testing** (pilot links, E2E residue). Confirm that all three conditions (`baseline`, `public-llm`, `private-llm`) are listed in Settings → Recruiting and at least one is **active** (the toggle lives there, not on Overview). The default group size is **3**, the default discussion length **10 minutes**, and the default recruiting goal **5** completed sessions per arm. The Overview also shows the current **study round** — pilot sessions are stamped into whatever round is open (Round 1 on a fresh stack).

### 2. Open participant links

Copy the **Study Link** from the admin dashboard's Overview tab:

```
http://localhost:3000/
```

This is the single link researchers hand out. Each tab that opens it self-issues a random tracking token and gets auto-assigned to the active condition with the fewest claimed sessions in the current round.

Open it in **3 separate browser tabs** (one per participant, matching the group size). To force a specific condition, use a pilot link from the **Testing** tab instead:

```
http://localhost:3000/?conditionId=public-llm
```

(The seeded condition ids are `baseline`, `public-llm`, `private-llm`.)

### 3. Walk through the flow

In each tab:

1. **Recruiting** — click "Start"
2. **Consent** — accept informed consent (three checkboxes)
3. **About You** — fill in the demographic questionnaire (age, gender, education, English proficiency). A shared 5-minute questionnaire countdown starts after consent.
4. **About You (attitudes)** — answer the AI-attitude and personality matrices plus teamwork, chat-comfort and topic-familiarity questions using the remaining questionnaire time. At expiry, entered answers are kept, unanswered fields remain absent, and the individual ranking task begins.
5. **Ranking Task** — complete the individual Moon Survival ranking (5-minute timer)
6. **Group Intro** — read the group discussion explanation, continue
7. **Waiting Room** — shows "N / 3 people joined" and the remaining lobby time (`WAITING_TIMEOUT_MINUTES`, default 5), waits for all tabs to arrive
8. **Chat** — once the group is full, a Matrix room is created and all participants enter the chat. A timer counts down based on `durationMinutes`.
9. **Exit Survey** — after the discussion ends, participants get 2 minutes for their final individual ranking, then a shared 5 minutes for both reflection pages. Ranking expiry keeps the current order and advances; questionnaire expiry submits entered answers automatically. Failed submissions offer a retry without dropping answers.
10. **Debriefing** — study explanation, optional feedback box, and completion link

### 4. Observe bot behavior

To trigger an intervention:
- Have one participant send several long messages
- Keep at least one participant silent
- Wait for the first contribution-window boundary: the bot evaluates only at window ends. The first window opens when the warm-up passes (default: 3 minutes) and closes one window length later (default: 4 minutes), so the first possible nudge is about 7 minutes into the default 10-minute discussion
- The bot should post a nudge based on the condition's intervention mode (nothing in `baseline`)

See [docs/bot-rulebook.md](bot-rulebook.md) for the full intervention logic and [docs/pilot-checklist.md](pilot-checklist.md) for a step-by-step verification list.

## Useful Commands

### Reset all data (Synapse + research DB)

```bash
cd infra
docker compose down -v
docker compose up --build
```

### Reset only research data

```bash
cd infra
docker compose down
docker volume rm infra_research-db-data
docker compose up --build
```

### Inspect databases

```bash
# Synapse Postgres
docker compose exec synapse-db psql -U synapse -d synapse

# Research Postgres
docker compose exec research-db psql -U gdm -d gdm_research
```

### Run Prisma migrations locally

With the Docker stack running:

```bash
DATABASE_URL=postgresql://gdm:gdm_secret@localhost:5433/gdm_research?schema=public \
  pnpm --filter session-manager db:migrate
```

### Run tests

```bash
corepack prepare pnpm@11.8.0 --activate
pnpm install --frozen-lockfile

pnpm test              # unit tests (seconds, no Docker)
pnpm test:integration  # backend integration tests (needs Docker; starts throwaway Postgres/Synapse)
pnpm test:e2e          # Playwright e2e suite (needs the compose stack running; disruptive/billed specs self-skip unless env-gated on)
```

See [testing.md](testing.md) for what each layer covers and its conventions.

## Configuration

All environment variables live in `infra/.env` (template: `infra/.env.example`). Defaults below are the template values; where the compose file or the code substitutes a different value when a variable is unset, that is noted.

| Variable | Purpose |
|---|---|
| `GDM_ENV` | `development` (default) or `production` — in production the backends refuse to start with weak secrets, a localhost `MATRIX_PUBLIC_URL`, or a missing `ANTHROPIC_API_KEY` (see [deployment.md](deployment.md)) |
| `SYNAPSE_SERVER_NAME` | Matrix server name (`localhost`); immutable after Synapse's first start |
| `SYNAPSE_REPORT_STATS` | Synapse anonymous statistics opt-in (`no`) |
| `SYNAPSE_HTTP_PORT` | Host port for Synapse (`8010`; compose falls back to `8008` if unset) |
| `SYNAPSE_DB_NAME` / `SYNAPSE_DB_USER` / `SYNAPSE_DB_PASSWORD` | Synapse Postgres credentials (`synapse` / `synapse` / `synapse_secret`) |
| `RESEARCH_DB_NAME` / `RESEARCH_DB_USER` / `RESEARCH_DB_PASSWORD` | Research Postgres credentials (`gdm_research` / `gdm` / `gdm_secret`) |
| `DATABASE_URL` | Host-side connection string for local Prisma commands |
| `SYNAPSE_SIGNING_KEY_PATH` | Listed in the template but not consumed anywhere: the dev `homeserver.yaml` hardcodes the path and the production template derives it from `SYNAPSE_SERVER_NAME` |
| `MATRIX_PUBLIC_URL` | Browser-facing Matrix URL returned to participants (`http://localhost:3000`; the code falls back to `http://localhost:8008` if unset) |
| `PARTICIPANT_PUBLIC_URL` | Recruiting link shown in the admin dashboard (baked into its image at build time; production images carry the CI value) |
| `PUBLIC_HOST`, `ACME_EMAIL` | Production reverse-proxy host and Let's Encrypt contact — see [deployment.md](deployment.md) |
| `ADMIN_API_TOKEN` | Protects researcher endpoints; empty = open (dev only); production requires ≥ 32 characters |
| `INTERNAL_API_TOKEN` | Shared secret between Session Manager and Chat Service; empty = open (dev only); production requires ≥ 32 characters |
| `CORS_ORIGINS` | Optional comma-separated extra browser origins for development/staging; production is same-origin |
| `MATRIX_SERVICE_PASSWORD` | Password of the stable `gdm_orchestrator` Matrix account (`gdm-dev-orchestrator-password`); production requires a fresh ≥ 32-character secret |
| `MATRIX_RATE_LIMIT_RETRIES`, `MATRIX_RETRY_MAX_DELAY_MS`, `MATRIX_REQUEST_TIMEOUT_MS` | Bounded retries on Synapse `M_LIMIT_EXCEEDED` (`8`, `30000`, `15000`), used by both backends |
| `MATRIX_SYNC_REQUEST_TIMEOUT_MS` | Chat Service `/sync` HTTP timeout (`40000`; must exceed the 30-second long-poll) |
| `WAITING_TIMEOUT_MINUTES` | Shared waiting-lobby deadline, starting when the lobby is created by its first participant (`5`; floored at 1) |
| `PARTICIPANT_RECONNECT_GRACE_SECONDS` | Maximum missing-heartbeat window before a Prolific participant is terminally disconnected (`30`; floored at 5) |
| `CHECKPOINT_TIMEOUT_MS` | Upper bound for one Chat Service checkpoint/finalize request (`30000`) |
| `PROLIFIC_STUDY_ID` | Only this 24-character Prolific study may claim a Prolific seat (empty = study check skipped) |
| `PROLIFIC_API_TOKEN` | Server-only researcher token; when set, Prolific parameters are validated against Prolific's submission API |
| `PROLIFIC_REQUIRE_VALIDATION` | `true` makes a production start fail unless study id and token are configured (`false`) |
| `PARTIAL_PAYMENT_PENCE_PER_MINUTE` | Rounded-up partial-compensation rate (`10`; minimum enforced 10) |
| `PARTIAL_PAYMENT_MAX_PENCE` | Hard cap for a queued partial payment (`508`; floored at 10) |
| `PROLIFIC_AUTO_RETURN_DISCONNECTS` | When `true`, ask Prolific to request a submission return after a connection timeout; does not pay bonuses (`false`) |
| `PROLIFIC_PAYMENT_AUTOMATION` | When `true`, processes due return and bonus actions automatically every 30 s; keep `false` for researcher review |
| `LLM_MODE` | Optional global override: `off` kill switch for the classifier, `active` forces it on everywhere (including baseline); any other value is ignored; leave empty normally |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Used for fresh nudge wording in both nudging arms, for the classifier, and for moderation (`claude-haiku-4-5-20251001`); without a key classifications are recorded as failures, dominance drops to 0.9 × share and nudges use fixed fallback text; in production the Chat Service refuses to start without it |
| `MODERATION` | `on` enables LLM moderation of participant messages (abusive messages are redacted and the sender warned privately); anything else = off |

Variables read by the code but not listed in the template: `SESSION_MANAGER_BODY_LIMIT` (request body cap), `PORT` (each backend's listen port), `MATRIX_INTERNAL_URL`, `SESSION_MANAGER_URL`, `CHAT_SERVICE_URL` (set by compose for the container network), `IMAGE_PREFIX` / `IMAGE_TAG` / `SYNAPSE_CONFIG_SHA` (production compose and `deploy.sh`), and `VITE_PAYMENT_URL` (build-time completion-link fallback of the participant frontend).

The Synapse `homeserver.yaml` at `infra/synapse/homeserver.yaml` has its own DB credentials that must match the `.env` values (Synapse reads static YAML, not environment variables). Production uses `homeserver.prod.yaml` instead, rendered from a template by `infra/render-homeserver.sh`.

The compose setup is split across three files in `infra/`: `docker-compose.yml`
(services, no host ports), `docker-compose.override.yml` (dev port mappings,
merged automatically by `docker compose up`) and `docker-compose.prod.yml`
(reverse proxy, prebuilt images — see [deployment.md](deployment.md)).

For the optional text workspace, see [Etherpad study mode](etherpad.md). It is included in the local Docker stack and starts disabled.
