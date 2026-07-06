# GDM Platform

AI-supported group decision-making study platform for a master's project.

The current branch is a local, Docker-first pilot stack:

- `packages/shared` - shared TypeScript domain models, DTOs, bot config, and mock Expedition Mars task
- `backend/session-manager` - NestJS API for matchmaking, session state, condition config, surveys, and Matrix room provisioning
- `backend/chat-service` - NestJS bot runtime that joins Matrix rooms, records messages/reactions/ranking edits, and emits rule-based interventions
- `frontend/participant` - React participant flow: study link, survey, waiting room, chat, shared ranking, exit survey
- `frontend/admin-dashboard` - React researcher dashboard for condition settings and progress
- `infra` - Docker Compose stack with Synapse, Synapse Postgres, research Postgres, backends, and frontends

## Local Run

No host Node or pnpm setup is required for the app stack.

```bash
cd infra
docker compose up --build
```

Or use the helper scripts:

```bash
./infra/start.sh
./infra/stop.sh
```

To wipe local Docker volumes, including Synapse and research Postgres data:

```bash
./infra/stop.sh --volumes
```

Open:

- Participant app: http://localhost:3000/?p=p1
- More participants: http://localhost:3000/?p=p2 and http://localhost:3000/?p=p3
- Admin dashboard: http://localhost:3003
- Session Manager API: http://localhost:3001/api/conditions/progress
- Synapse: http://localhost:8010
- Research Postgres on host: `localhost:5433`

The default local group size is `3` so a test group can fill quickly. Conditions are assigned across the four bot intervention methods by least-claimed condition.

For forced-condition pilot runs, use the pilot links in the admin dashboard or pass a condition explicitly:

```text
http://localhost:3000/?p=pilot-private-engaging-1&conditionId=private-engaging
```

## Bot Conditions

The current study model has four intervention methods:

| Condition | Audience | Behavior |
|---|---|---|
| Public Neutral | group | show current participation split |
| Public Engaging | group | show participation split and prompt the top contributor to include quieter members |
| Private Neutral | dominating member(s) | privately show current participation split |
| Private Engaging | dominating member(s) | privately show participation split and prompt them to include quieter members |

The rule engine uses a configurable contribution score:

```text
score = messageCount * messageWeight + characterCount * characterWeight
```

Defaults live in `packages/shared/src/interventions.ts`. Condition instances are seeded by the Session Manager into the research database when `DATABASE_URL` is configured.

## Admin And Export

The admin dashboard works against the Session Manager API. In Docker, sessions, participants, surveys, ranking history, messages, reactions, interventions, and condition settings are persisted in the dedicated research Postgres database.
It supports:

- condition settings and progress
- forced-condition pilot links
- session list and raw session detail
- intervention audit log
- JSON export at `/api/export/sessions`
- CSV summary export at `/api/export/sessions.csv`

Use `docs/pilot-checklist.md` for a repeatable local pilot flow.

## Useful Commands

Reset all local Matrix data:

```bash
cd infra
docker compose down -v
docker compose up --build
```

Reset only research data:

```bash
cd infra
docker compose down
docker volume rm infra_research-db-data
docker compose up --build
```

Inspect Synapse Postgres:

```bash
cd infra
docker compose exec synapse-db psql -U synapse -d synapse
```

Inspect research Postgres:

```bash
cd infra
docker compose exec research-db psql -U gdm -d gdm_research
```

Run local Prisma commands from the repo root after the Docker DB is up:

```bash
DATABASE_URL=postgresql://gdm:gdm_secret@localhost:5433/gdm_research?schema=public \
  pnpm --filter session-manager db:migrate
```

Run workspace tests on a machine with Node/Corepack available:

```bash
corepack prepare pnpm@11.8.0 --activate
pnpm install --frozen-lockfile
pnpm test
```

## Current Deferrals

These are intentionally not implemented yet:

- final NASA/Mars task specification and scoring
- standalone export service, if later needed beyond the current DB-backed API endpoints
- semantic/LLM contribution classifier
- typing-speed and tab-visibility telemetry
- Matrix appservice registration for the bot
