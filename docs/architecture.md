# Architecture

System architecture, service responsibilities, and data flow.

## Overview

The GDM platform is a monorepo with two backends, two frontends, a shared type package, and a Docker Compose infrastructure layer. All services communicate over HTTP and the Matrix protocol.

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

## Services

### Shared Package (`packages/shared`)

TypeScript domain models, DTOs, and constants shared across all services. Defines the contract for `Session`, `Participant`, `Condition`, `Message`, `InterventionConfig`, identity assignment, and the Expedition Mars task.

### Session Manager (`backend/session-manager`)

NestJS API responsible for:

- **Condition management** — CRUD for experimental conditions, seeded on first startup with the four 2x2 arms.
- **Matchmaking** — `POST /api/sessions` places a participant into a forming group. If no group exists for the assigned condition, one is created. When the group reaches `groupSize`, a Matrix room is provisioned.
- **Condition assignment** — if the participant URL includes a `conditionId`, that condition is used. Otherwise, the system picks the least-completed active condition (balanced assignment).
- **Matrix integration** — registers participant Matrix users, creates rooms, invites participants.
- **Survey persistence** — stores entry and exit survey responses.
- **Session lifecycle** — tracks status transitions: `waiting` -> `running` -> `completed`.
- **Export** — JSON and CSV export endpoints for all research data.

Data is stored in the research Postgres database via Prisma ORM.

### Chat Service (`backend/chat-service`)

NestJS bot runtime responsible for:

- **Matrix sync** — a bot user joins each session's room and tails the `/sync` stream for real-time events.
- **Event processing** — normalizes Matrix events (messages, reactions, ranking edits, redactions) and feeds them to the session runtime.
- **Bot rules** — the `ContributionBotRules` engine evaluates every message against the condition's intervention config and sends nudges when thresholds are crossed. See [bot-rulebook.md](bot-rulebook.md).
- **Session runtime** — one `SessionRuntime` instance per active session, collecting messages, reactions, ranking history, and intervention logs.

The chat service receives a notification from the session manager when a room is provisioned, joins the room, and starts monitoring.

### Participant Frontend (`frontend/participant`)

React SPA served by nginx. Implements the participant journey:

1. **Recruiting** — reads tracking token and optional condition ID from the URL
2. **Survey** — pre-study questionnaire
3. **Waiting Room** — calls `POST /api/sessions` to join, polls for group readiness
4. **Chat** — Matrix-based group chat with WhatsApp-style UI, shared ranking panel, briefing panel, countdown timer
5. **Exit Survey** — post-study questionnaire with individual re-ranking
6. **Done** — thank-you screen

Nginx proxies `/api/` to the session manager and `/_matrix/` to Synapse, so the browser only connects to `localhost:3000`.

### Admin Dashboard (`frontend/admin-dashboard`)

React SPA for researchers. Provides condition configuration, session monitoring, intervention audit, and data export. Nginx proxies `/api/` to the session manager.

> **Note:** The admin dashboard is currently being refactored. See the session manager API for the stable data contract.

## Session Lifecycle

```
Participant opens study link
        |
        v
  POST /api/sessions (Session Manager)
        |
        ├── Find or create a "waiting" session for the condition
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
```

## Data Flow

- **Participant -> Session Manager**: join requests, survey submissions
- **Session Manager -> Matrix (Synapse)**: user registration, room creation, room invites
- **Session Manager -> Chat Service**: session start notification
- **Participant -> Matrix**: chat messages, reactions, ranking edits (via matrix-js-sdk)
- **Chat Service -> Matrix**: bot nudge messages (public or private)
- **Matrix -> Chat Service**: real-time event stream via `/sync`
- **Chat Service -> Session Manager**: finalized session data at session end
- **Admin Dashboard -> Session Manager**: condition updates, session queries, exports

## Key Design Decisions

- **Matrix as the chat layer.** Provides real-time messaging, per-message metadata (sender, timestamp), bot integration via the sync API, and the ability to self-host. Participants never interact with Matrix directly; the frontend abstracts it.
- **Private messages in a shared room.** Rather than creating per-participant DM rooms, private bot nudges are sent to the group room with a custom `de.gdm.recipient` content field. The frontend filters visibility client-side. This simplifies room management while preserving the research requirement for private nudges.
- **Condition snapshot at session creation.** A session copies its condition config when created. Admin changes to conditions only affect future sessions, ensuring running experiments are not disrupted.
- **Two separate Postgres databases.** Synapse has its own database (chat protocol state). Research data (sessions, surveys, interventions) lives in a dedicated database with a Prisma-managed schema, keeping study data cleanly separated.
