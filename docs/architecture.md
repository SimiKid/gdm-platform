# Architecture

System architecture, service responsibilities, and data flow.

## Overview

The GDM platform is a monorepo with two backend services, two frontends, a shared type package, a Playwright e2e suite (`e2e/`), a k6 load-test harness (`loadtest/`), and a Docker Compose infrastructure layer. (`backend/export-service/` is an empty placeholder for a possible future standalone export service.) All services communicate over HTTP and the Matrix protocol.

```
┌─────────────────────────────────────────────────────────────────┐
│  Docker Compose                                                 │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐    │
│  │  Participant  │   │    Admin     │   │     Synapse      │    │
│  │  Frontend     │   │  Dashboard   │   │  (Matrix server) │    │
│  │  :3000        │   │  :3003       │   │  :8010           │    │
│  └──────┬───────┘   └──────┬───────┘   └────────┬─────────┘    │
│         │ /api/            │ /api/               │              │
│         v                  v                     │              │
│  ┌─────────────────────────────┐                 │              │
│  │      Session Manager        │                 │              │
│  │      :3001                  │─── creates ─────┤              │
│  │  (matchmaking, sessions,    │    rooms/users   │              │
│  │   conditions, surveys,      │                 │              │
│  │   exports)                  │                 │              │
│  └──────────────┬──────────────┘                 │              │
│                 │ notifies                       │              │
│                 v                                │              │
│  ┌──────────────────────────┐                    │              │
│  │      Chat Service        │── /sync ───────────┘              │
│  │      :3002               │                                   │
│  │  (bot runtime, rules,    │                                   │
│  │   message recording)     │                                   │
│  └──────────────────────────┘                                   │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐                            │
│  │  Synapse DB   │   │ Research DB  │                            │
│  │  (Postgres)   │   │ (Postgres)   │                            │
│  │  internal     │   │ :5433        │                            │
│  └──────────────┘   └──────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

The diagram shows the local dev topology (ports from
`docker-compose.override.yml`). In production nothing is exposed directly:
a Caddy reverse proxy on 80/443 terminates TLS and routes `/_matrix` → Synapse
(registration blocked), `/api` → Session Manager, `/admin` → the UZH-network-
and-token-protected admin dashboard and everything else to the participant
frontend. Caddy applies the same source-network restriction to researcher-only
API routes while participant API routes remain public. A localhost SSH tunnel
remains available as an admin fallback. See
[deployment.md](deployment.md).

## Services

### Shared Package (`packages/shared`)

TypeScript domain models, DTOs, and constants shared across all services. Defines the contract for `Session`, `Participant`, `Condition`, `Message`, `InterventionConfig`, identity assignment, and the Moon Survival task.

### Session Manager (`backend/session-manager`)

NestJS API responsible for:

- **Condition management** — CRUD for experimental conditions, seeded on first startup with five arms (baseline + 2x2: public/private delivery x rule-based/rule+LLM detection, carried by `llmMode`).
- **Study rounds** — numbered data-collection rounds with per-round recruiting goals (`GET/POST /api/rounds`, `PUT /api/rounds/:number`). New sessions are stamped with the active round; starting a new round aborts any still-waiting lobbies from the previous round.
- **Matchmaking** — `POST /api/sessions` places a participant into a forming group. If no group exists for the assigned condition, one is created. When the group reaches `groupSize`, a Matrix room is provisioned.
- **Condition assignment** — if the join request includes a `conditionId` (e.g. from a pilot link `?conditionId=public-rule`), that condition is used. Otherwise, the system picks the least-completed active condition (balanced assignment). Assignment happens server-side.
- **Matrix integration** — registers participant Matrix users, creates rooms, invites participants.
- **Stable room ownership** — the `gdm_orchestrator` Matrix account logs in
  with `MATRIX_SERVICE_PASSWORD`, so invite-only rooms remain manageable after
  Session Manager or full-stack restarts.
- **Survey persistence** — stores entry and exit survey responses.
- **Session lifecycle** — tracks status transitions: `waiting` -> `running` -> `completed`; a waiting lobby becomes `aborted` when a new study round starts.
- **Reports & export** — summary statistics for the Results tab plus pseudonymized analysis CSVs (participants, sessions, windows, rankings), a separately guarded linkage file, and a research ZIP with codebook. All report/export endpoints accept a `roundIds` filter. See [data-export.md](data-export.md).

Data is stored in the research Postgres database via Prisma ORM.

### Chat Service (`backend/chat-service`)

NestJS bot runtime responsible for:

- **Matrix sync** — a bot user joins each session's room and tails the `/sync` stream for real-time events.
- **Event processing** — normalizes Matrix events (messages, reactions, ranking edits, redactions) and feeds them to the session runtime.
- **Bot rules** — the `ContributionBotRules` engine evaluates every message against the condition's intervention config and sends nudges when thresholds are crossed. See [bot-rulebook.md](bot-rulebook.md).
- **LLM classifier** — in `llmMode: "active"` arms, an Anthropic-backed contribution classifier (`src/classifier/`) scores message meaningfulness; the scores feed the composite dominance metric and invite grace, but never trigger nudges on their own.
- **Session runtime** — one `SessionRuntime` instance per active session, collecting messages, reactions, ranking history, and intervention logs.
- **Durable checkpoints** — live runtimes checkpoint messages, behavioral events,
  semantic classifications, processed Matrix event IDs, and rule tracker state
  into the research database. After restart the service registers a new bot,
  asks the Session Manager to re-invite it, restores running sessions, and
  replays only unprocessed Matrix events.

The chat service receives a notification from the session manager when a room is provisioned, joins the room, and starts monitoring.

### Participant Frontend (`frontend/participant`)

React SPA served by nginx. Implements the participant journey:

1. **Recruiting** — self-issues a tracking token (or reads one from `?p=`), optionally reads a forced condition from `?conditionId=` or `?c=`
2. **Consent** — informed consent page
3. **About You** — demographic questionnaire
4. **Ranking Task** — individual Moon Survival ranking with a 10-minute timer
5. **Group Intro** — explanation of the upcoming group discussion
6. **Waiting Room** — calls `POST /api/sessions` to join, polls for group readiness
7. **Chat** — Matrix-based group chat with WhatsApp-style UI, briefing panel, countdown timer, and a condition-selected shared workspace. Structured ranking is the default; a dormant external-iframe extension point shows a not-configured placeholder until a provider is supplied.
8. **Exit Survey** — post-study questionnaire with individual re-ranking
9. **Debriefing** — study explanation and compensation link

Nginx proxies `/api/` to the session manager and `/_matrix/` to Synapse, so the browser only connects to `localhost:3000`.

### Admin Dashboard (`frontend/admin-dashboard`)

React SPA for researchers, split into four tabs:

- **Overview** — study link, condition progress, session list.
- **Results** — per-condition result summaries with a study-round filter, research exports (analysis ZIP, individual CSVs), and a guarded identifying-data section.
- **Settings** — recruiting table (per-condition active/goal), study rounds management, shared session & bot parameters (applied to all arms, with a drift warning when arms deviate), compensation link.
- **Testing** — bot test workspace, including the 2-bot comparison toggle for non-baseline arms.

Nginx proxies `/api/` to the session manager.

## Session Lifecycle

```
Participant opens http://localhost:3000/
  -> Recruiting: self-issues a tracking token, clicks "Start"
  -> Consent: informed consent
  -> About You: demographic questionnaire
  -> Ranking Task: individual Moon Survival ranking (10-min timer)
  -> Group Intro: explanation of group discussion
        |
        v
  POST /api/sessions (Session Manager)
        |
        ├── Assign condition (explicit conditionId or least-completed active)
        ├── Find or create a "waiting" session for the condition
        ├── Stamp the session with the active study round
        ├── Register a Matrix user for the participant
        └── Return session + Matrix credentials
        |
        v
  Participant enters waiting room, polls GET /api/sessions/:id
        |
        v
  Group reaches groupSize
        |
        ├── Session Manager creates a Matrix room
        ├── Invites all participants
        ├── Sets status = "running"
        └── Notifies Chat Service with session details
        |
        v
  Chat Service joins room, starts monitoring
  Participants enter chat
        |
        v
  Timer expires -> status = "completed"
  Chat Service finalizes session (messages, rankings, interventions)
  Participants enter exit survey
        |
        v
  Debriefing: study explanation and compensation link
```

## Data Flow

- **Participant -> Session Manager**: join requests, survey submissions
- **Session Manager -> Matrix (Synapse)**: user registration, room creation, room invites
- **Session Manager -> Chat Service**: session start notification
- **Participant -> Matrix**: chat messages and ranking edits (via matrix-js-sdk); emoji reactions are intentionally unsupported in the UI per study protocol
- **Participant -> Matrix**: batched typing, cursor activity, and tab-visibility telemetry
- **Chat Service -> Matrix**: bot nudge messages (public or private)
- **Matrix -> Chat Service**: real-time event stream via `/sync`
- **Chat Service -> Session Manager**: finalized session data at session end
- **Chat Service -> Session Manager**: incremental live checkpoints and final session data
- **Admin Dashboard -> Session Manager**: condition updates, study settings (compensation link), study round management (start/edit rounds), session queries, result summaries, exports

## Key Design Decisions

- **Matrix as the chat layer.** Provides real-time messaging, per-message metadata (sender, timestamp), bot integration via the sync API, and the ability to self-host. Participants never interact with Matrix directly; the frontend abstracts it.
- **Private messages in a shared room.** Rather than creating per-participant DM rooms, private bot nudges are sent to the group room with a custom `de.gdm.recipient` content field. The frontend filters visibility client-side. This simplifies room management while preserving the research requirement for private nudges.
- **Condition snapshot at session creation.** A session copies its condition config when created. Admin changes to conditions only affect future sessions, ensuring running experiments are not disrupted.
- **Ranking-safe workspace extension point.** `condition.config.workspaceMode` defaults and normalizes to `ranking`. Researchers can prepare future sessions for an `external` iframe from the shared Settings control, but no provider, authentication, lifecycle integration, or artifact collection is currently configured. External mode therefore renders an explicit placeholder rather than silently pretending to collect task data.
- **Two separate Postgres databases.** Synapse has its own database (chat protocol state). Research data (sessions, surveys, interventions) lives in a dedicated database with a Prisma-managed schema, keeping study data cleanly separated.
