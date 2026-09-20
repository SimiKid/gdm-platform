# Architecture

System architecture, service responsibilities, and data flow.

## Overview

The GDM platform is a monorepo with two backend services, two frontends, a shared type package, a Playwright e2e suite (`e2e/`), a k6 load-test harness (`loadtest/`), and a Docker Compose infrastructure layer. (`backend/export-service/` is an empty placeholder — a single `.gitkeep` — for a possible future standalone export service.) All services communicate over HTTP and the Matrix protocol.

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
(public registration, login, room creation, invites, federation and key
endpoints blocked), `/api` → Session Manager, `/admin` → the UZH-network-
and-token-protected admin dashboard and everything else to the participant
frontend. Caddy applies the same source-network restriction to researcher-only
API routes while participant API routes remain public. A localhost SSH tunnel
remains available as an admin fallback. See
[deployment.md](deployment.md).

Both frontends and both backends talk to an external service in one place
only: the Chat Service calls Anthropic's Messages API for nudge wording, for
the contribution classifier in the nudging arms, and for optional chat
moderation. The Session Manager calls Prolific's API when a researcher token
is configured (submission validation, returns, bonuses).

A Structurizr C4 model of the same system lives in
`docs/architecture/workspace.dsl` (`workspace.json` is its exported layout).

## Services

### Shared Package (`packages/shared`)

TypeScript domain models, DTOs, and constants shared across all services. Defines the contract for `Session`, `Participant`, `Condition`, `Message`, `InterventionConfig`, `WindowEvaluation`, the Prolific lifecycle records, identity assignment, and the Moon Survival task (10 items and the expert ranking; the NASA error score itself is computed in the Session Manager's reports module).

### Session Manager (`backend/session-manager`)

NestJS API (all routes under `/api`) responsible for:

- **Condition management** — `GET /api/conditions`, `GET /api/conditions/progress` (completed-vs-goal for the current round) and `PUT /api/conditions/:id`. There is no delete route; `PUT` is an upsert, so an unknown id creates a condition (this is how the e2e suite mints its `e2e-…` arms). The three study arms (`baseline`, `public-llm`, `private-llm` — a silent baseline plus public/private nudge delivery, both nudging arms using rule+LLM detection) are seeded on first startup and edited in place. Admin input is normalized and clamped on save (see [bot-rulebook.md](bot-rulebook.md)).
- **Study rounds** — numbered data-collection rounds with per-round completed counts (`GET/POST /api/rounds`, `PUT /api/rounds/:number`). New sessions are stamped with the active round; starting a new round aborts any still-waiting lobbies from the previous round.
- **Matchmaking** — `POST /api/sessions` places a participant into a forming group. If no group exists for the assigned condition, one is created and given a waiting deadline (`WAITING_TIMEOUT_MINUTES`, default 5). When the group reaches `groupSize`, the session moves to `provisioning` and a Matrix room is created in the background; repeated join calls are idempotent and return the existing seat.
- **Condition assignment** — if the join request includes a `conditionId` (e.g. from a pilot link `?conditionId=public-llm`), that condition is used if it is active and below its goal. Otherwise, the system picks the active condition with the **fewest claimed sessions in the current round** (waiting, provisioning, running and completed sessions all count; aborted ones do not) that has not reached its goal. Assignment happens server-side.
- **Matrix integration** — registers participant Matrix users, creates rooms, invites participants, kicks participants from aborted rooms.
- **Stable room ownership** — the `gdm_orchestrator` Matrix account logs in
  with `MATRIX_SERVICE_PASSWORD`, so invite-only rooms remain manageable after
  Session Manager or full-stack restarts (the bot registers a fresh
  `gdm_bot_<suffix>` account on every start and must be re-invited).
- **Survey persistence** — stores entry and exit survey responses (`POST /api/surveys`, validated against a fixed key list) and the optional debriefing feedback (`POST /api/surveys/debrief-feedback`, merged into the exit answers).
- **Session lifecycle** — status transitions: `waiting` → `provisioning` → `running` → `completed`. A session becomes `aborted` when its waiting deadline passes (outcome `unmatched`, or `technical_failure` if it was stuck provisioning), when a new study round starts, when a Prolific participant of a provisioning/running group disconnects (the whole group is aborted and all members are kicked from the room) or withdraws (group aborted, no kick), or when the last participant of a waiting lobby is terminated (an earlier termination only frees the seat). The end of the discussion is reported by the Chat Service (`POST /api/sessions/:id/finalize`), which sets `completed`; `POST /api/sessions/:id/complete` exists for the same purpose but is not called by the current participant app. Each participant is marked complete individually once their exit survey is stored.
- **Prolific lifecycle** — `POST /api/prolific/{arrivals,resume,progress,terminate,outcome}` record arrivals before consent, heartbeats with the current stage, resumes, early exits, and terminal outcomes. A heartbeat gap longer than `PARTICIPANT_RECONNECT_GRACE_SECONDS` (default 30, sweep every 5 s) terminalizes the participant (`connection_timeout`), removes their seat or aborts their live group, and queues the compensation action. Researchers review those actions under `GET /api/admin/prolific/outcomes` and `POST /api/admin/prolific/outcomes/:id/actions/:action`. See [prolific-integration.md](prolific-integration.md).
- **Study settings** — `GET/PUT /api/settings` hold the Prolific completion and early-exit URLs.
- **Reports & export** — summary statistics for the Results tab (`GET /api/reports/summary`) plus pseudonymized analysis CSVs (participants, sessions, windows, rankings), a separately guarded linkage file, a research ZIP with codebook, an identifying wide-format "research data" ZIP for the Overview tab, the raw per-family exports, and the Prolific arrival/outcome exports. All session-based report/export endpoints accept `conditionIds` and `roundIds` filters. See [data-export.md](data-export.md).
- **Health** — `GET /api/health` and `GET /api/health/ready`.

Researcher routes are guarded by `ADMIN_API_TOKEN`, participant routes by the seat credential issued at join time, and Chat-Service routes (`finalize`, `checkpoint`, `recover`) by `INTERNAL_API_TOKEN`. Data is stored in the research Postgres database via Prisma ORM; migrations run automatically at container start.

### Chat Service (`backend/chat-service`)

NestJS bot runtime responsible for:

- **Matrix sync** — a bot user joins each session's room and tails the `/sync` stream for real-time events.
- **Event processing** — normalizes Matrix events (messages, reactions, ranking edits, redactions, behavioral telemetry) and feeds them to the session runtime.
- **Bot rules** — the `ContributionBotRules` engine evaluates the contribution split at the end of every contribution window against the condition's intervention config and sends a nudge when the threshold is crossed. See [bot-rulebook.md](bot-rulebook.md).
- **LLM usage** — Anthropic's Messages API (a) generates fresh nudge wording for every intervention in the two nudging arms, (b) in those arms (`llmMode: "active"`) classifies every participant message for meaningfulness (`src/classifier/`); the scores feed the composite dominance metric and invite grace, but never trigger nudges on their own, and (c) optionally moderates participant messages when `MODERATION=on` (flagged messages are redacted and the sender gets a private warning). With `GDM_ENV=production` the service refuses to start without `ANTHROPIC_API_KEY`.
- **Session runtime** — one `SessionRuntime` instance per active session, collecting messages, reactions, ranking history, behavioral events, classifications, and intervention logs.
- **Durable checkpoints** — live runtimes checkpoint messages, behavioral events,
  semantic classifications, window evaluations, processed Matrix event IDs, and
  rule tracker state into the research database via the Session Manager
  (`PUT /api/sessions/:id/checkpoint`). After a restart the service registers
  a new bot, asks the Session Manager to re-invite it
  (`POST /api/sessions/recover`), restores running sessions, and replays only
  unprocessed Matrix events.
- **Internal API** — `POST /internal/sessions/start` (called by the Session Manager when a room is provisioned), `GET /internal/bot`, and `GET /health[/ready]`.

The chat service receives a notification from the session manager when a room is provisioned, joins the room, and starts monitoring.

### Participant Frontend (`frontend/participant`)

React SPA served by nginx. Implements the participant journey:

1. **Recruiting** — self-issues a tracking token (or reads one from `?p=`), optionally reads a forced condition from `?conditionId=` or `?c=`, and reads the Prolific parameters `PROLIFIC_PID`, `STUDY_ID`, `SESSION_ID` (all three or none; a partial set is rejected). For `?p=` and Prolific links the token/Prolific parameters are stripped from the address bar after being read (a forced `conditionId` is kept); the generic link leaves the URL untouched.
2. **Consent** — informed consent (three checkboxes); declining ends participation.
3. **About You** — demographics (age, gender, education, English proficiency); age under 18 or English proficiency "None" ends participation as ineligible.
4. **Attitudes** (shown as a second "About You" page) — General Attitudes towards AI Scale (10 items), Ten-Item Personality Inventory, teamwork frequency, chat comfort, spaceflight and survival familiarity.
5. **Ranking Task** — individual Moon Survival ranking with a **5-minute** timer (auto-completed in shown order on expiry).
6. **Group Intro** — explanation of the upcoming group discussion.
7. **Waiting Room** — calls `POST /api/sessions` to join, polls for group readiness, shows the waiting deadline.
8. **Chat** — Matrix-based group chat with WhatsApp-style UI, @mention picker, briefing panel, countdown timer (red "wrap up!" cue during the protected end), and a condition-selected shared workspace. Structured ranking is the default; a dormant external-iframe extension point shows a not-configured placeholder until a provider is supplied.
9. **Exit Survey** — three steps: individual re-ranking, task confidence + group-dynamics items, psychological-safety + bot-perception items (the bot block is shown in every arm).
10. **Debriefing** — study explanation, an optional free-text feedback box, an acknowledgement checkbox, and the completion link (Prolific completion URL from Settings, or `VITE_PAYMENT_URL` as build-time fallback).

Early exits (consent declined, ineligible, voluntary withdrawal, disconnect, unmatched lobby, aborted group) land on a **study-exit page** that shows the server-recorded outcome, any partial compensation recorded for review, and the matching Prolific return link. Post-consent exits receive the same debriefing disclosure before their return link becomes active; consent declines and eligibility screen-outs do not.

The frontend sends a Prolific heartbeat every 10 seconds with the current stage, and batched typing, cursor-activity and tab-visibility telemetry to Matrix.

Nginx proxies `/api/` to the session manager and `/_matrix/` to Synapse, so the browser only connects to `localhost:3000`.

### Admin Dashboard (`frontend/admin-dashboard`)

React SPA for researchers, gated by `ADMIN_API_TOKEN` (entered once, kept in `localStorage`), split into five tabs in this order:

- **Prolific** — durable participant outcomes and separately audited return/partial-bonus actions.
- **Overview** — metrics strip (current round, completed/goal, active, in lobby, total), the study link, per-condition progress for the current round, the session list with a per-session inspector (status, timing, participants by chat colour with per-person activity, message/nudge/classifier/behaviour tiles, a nudge response timeline — contribution share per participant per contribution window with nudge markers and message ticks — a before/after table for every nudge measured in the bot's own windows, and a window table), and the Export Data card (Research Data zip, full JSON dump).
- **Results** — per-condition result summaries with a study-round filter, research exports (analysis bundle, individual CSV/JSON datasets), and a guarded Identifying Data section (`linkage.csv`).
- **Settings** — recruiting table (per-condition active/goal), study rounds management, shared session & bot parameters (applied to all arms, with a drift warning when arms deviate), the shared workspace mode, and the Prolific completion/exit paths.
- **Testing** — bot test workspace: pilot links per arm and E2E test-condition residue.

Nginx proxies `/api/` to the session manager.

## Session Lifecycle

```
Participant opens http://localhost:3000/
  -> Recruiting: self-issues a tracking token (or reads Prolific params), clicks "Start"
  -> Consent: informed consent
  -> About You: demographic questionnaire
  -> Attitudes: AI attitudes, personality, teamwork/chat/topic questions
  -> Ranking Task: individual Moon Survival ranking (5-min timer)
  -> Group Intro: explanation of group discussion
        |
        v
  POST /api/sessions (Session Manager)
        |
        ├── Assign condition (explicit conditionId or fewest claimed sessions in the current round)
        ├── Find or create a "waiting" session for the condition (with waiting deadline)
        ├── Stamp the session with the active study round
        ├── Register a Matrix user for the participant
        └── Return session + Matrix credentials
        |
        v
  Participant enters waiting room, polls GET /api/sessions/:id
        |
        v
  Group reaches groupSize -> status = "provisioning"
        |
        ├── Session Manager creates a Matrix room
        ├── Invites all participants
        ├── Notifies Chat Service with session details (POST /internal/sessions/start)
        └── Sets status = "running" (only after the Chat Service accepted the session)
        |
        v
  Chat Service joins room, starts monitoring and checkpointing
  Participants enter chat
        |
        v
  Timer expires -> status = "completed"
  Chat Service finalizes session (messages, rankings, interventions, windows)
  Participants enter exit survey; each is marked complete once it is stored
        |
        v
  Debriefing: study explanation, optional feedback, completion link
```

## Data Flow

- **Participant -> Session Manager**: join requests, survey submissions, debrief feedback, Prolific arrivals/heartbeats/outcomes, per-participant completion
- **Session Manager -> Matrix (Synapse)**: user registration, room creation, room invites, kicks
- **Session Manager -> Chat Service**: session start notification
- **Participant -> Matrix**: chat messages and ranking edits (via matrix-js-sdk); emoji reactions are intentionally unsupported in the UI per study protocol
- **Participant -> Matrix**: batched typing, cursor activity, and tab-visibility telemetry
- **Chat Service -> Matrix**: bot nudge messages (public or private), moderation redactions and warnings
- **Matrix -> Chat Service**: real-time event stream via `/sync`
- **Chat Service -> Anthropic**: nudge wording, message classification (nudging arms), optional moderation
- **Chat Service -> Session Manager**: incremental live checkpoints, recovery requests after restart, and final session data at session end
- **Session Manager -> Prolific**: submission validation, return requests, bonus batches (only when `PROLIFIC_API_TOKEN` is set)
- **Admin Dashboard -> Session Manager**: condition updates, study settings (completion/exit URLs), study round management (start/edit rounds), session queries, result summaries, exports, Prolific compensation actions

## Key Design Decisions

- **Matrix as the chat layer.** Provides real-time messaging, per-message metadata (sender, timestamp), bot integration via the sync API, and the ability to self-host. Participants never interact with Matrix directly; the frontend abstracts it.
- **Private messages in a shared room.** Rather than creating per-participant DM rooms, private bot nudges are sent to the group room with a custom `de.gdm.recipient` content field. The frontend filters visibility client-side. This simplifies room management while preserving the research requirement for private nudges.
- **Condition snapshot at session creation.** A session copies its condition config when created. Admin changes to conditions only affect future sessions, ensuring running experiments are not disrupted.
- **Ranking-safe workspace extension point.** `condition.config.workspaceMode` defaults and normalizes to `ranking`. Researchers can prepare future sessions for an `external` iframe from the shared Settings control, but no provider, authentication, lifecycle integration, or artifact collection is currently configured. External mode therefore renders an explicit placeholder rather than silently pretending to collect task data.
- **Two separate Postgres databases.** Synapse has its own database (chat protocol state). Research data (sessions, surveys, interventions) lives in a dedicated database with a Prisma-managed schema, keeping study data cleanly separated.
- **Server-owned recruitment source.** Whether a participant is `direct` or `prolific` is decided by the Session Manager (Prolific parameters are validated against Prolific's API when a token is configured); the browser cannot claim Prolific status.
