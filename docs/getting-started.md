# Getting Started

How to run the GDM platform locally for development and pilot testing.

## Prerequisites

- **Docker Desktop** (or Docker Engine + Compose plugin) running on your machine
- No host-level Node.js or pnpm installation is required for running the app stack
- For running tests or Prisma commands locally: Node.js 20+ and `corepack prepare pnpm@11.8.0 --activate`

## Start the Stack

```bash
cd infra
sh start.sh
```

This builds and starts all services via Docker Compose. On first run, expect a longer build as Docker pulls base images and compiles the backends.

Alternatively, run directly:

```bash
cd infra
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
| Session Manager API | http://localhost:3001/api | Backend REST API for sessions, conditions, surveys |
| Chat Service | http://localhost:3002 | Bot runtime that monitors Matrix rooms |
| Synapse (Matrix) | http://localhost:8010 | Matrix homeserver |
| Research Postgres | `localhost:5433` | Study data (sessions, surveys, interventions) |

The participant frontend's nginx reverse-proxies `/api/` to the session manager and `/_matrix/` to Synapse, so the browser only talks to `localhost:3000`.

## Running a Pilot Session

### 1. Open the admin dashboard

Go to http://localhost:3003. Confirm that all five conditions (baseline + 4 intervention arms) are listed and at least one is **active**. The default group size is **3**.

### 2. Open participant links

Copy the **Study Link** from the admin dashboard's Overview tab:

```
http://localhost:3000/
```

This is the single link researchers hand out. Each tab that opens it self-issues a random tracking token and gets auto-assigned to the least-completed active condition.

Open it in **3 separate browser tabs** (one per participant, matching the group size). To force a specific condition, use a pilot link instead:

```
http://localhost:3000/?conditionId=public-neutral
```

### 3. Walk through the flow

In each tab:

1. **Recruiting** — click "Start"
2. **Consent** — accept informed consent
3. **About You** — fill in demographic questionnaire
4. **Ranking Task** — complete the individual Moon Survival ranking (10-minute timer)
5. **Group Intro** — read the group discussion explanation, continue
6. **Waiting Room** — shows "N / 3 people joined", waits for all tabs to arrive
7. **Chat** — once the group is full, a Matrix room is created and all participants enter the chat. A timer counts down based on `durationMinutes`.
8. **Exit Survey** — after the timer expires, participants complete a post-study questionnaire
9. **Debriefing** — study explanation and compensation link

### 4. Observe bot behavior

To trigger an intervention:
- Have one participant send several long messages
- Keep at least one participant silent
- Wait until the protected start window passes (default: 3 minutes)
- The bot should post a nudge based on the condition's intervention mode

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
pnpm test:e2e          # Playwright golden path (needs the compose stack running)
```

See [testing.md](testing.md) for what each layer covers and its conventions.

## Configuration

All environment variables live in `infra/.env`. Key settings:

| Variable | Purpose |
|---|---|
| `SYNAPSE_HTTP_PORT` | Host port for Synapse (default `8010`) |
| `SYNAPSE_DB_*` | Synapse Postgres credentials |
| `RESEARCH_DB_*` | Research Postgres credentials |
| `DATABASE_URL` | Host-side connection string for local Prisma commands |
| `MATRIX_PUBLIC_URL` | Browser-facing Matrix URL returned to participants (default `http://localhost:3000`) |

The Synapse `homeserver.yaml` at `infra/synapse/homeserver.yaml` has its own DB credentials that must match the `.env` values (Synapse reads static YAML, not environment variables).
