# GDM Platform

A study platform for researching AI-supported group decision-making. Groups discuss a shared task in a real-time chat environment while a rule-based bot monitors contribution balance and intervenes when participation becomes uneven.

The project investigates whether in-the-moment AI nudges can improve both decision quality and group experience, using a 2x2 between-subjects design (public/private x neutral/engaging interventions).

## Repository Structure

```
packages/shared/          Shared TypeScript types, DTOs, and defaults
backend/session-manager/  Matchmaking, session state, conditions, surveys, exports (NestJS + Prisma)
backend/chat-service/     Bot runtime: Matrix sync, message recording, intervention rules (NestJS)
frontend/participant/     Participant study flow: recruiting, survey, chat, exit survey (React)
frontend/admin-dashboard/ Researcher dashboard for conditions and exports (React)
infra/                    Docker Compose stack, Synapse config, env, start/stop scripts
docs/                     Architecture, bot rulebook, pilot checklist
```

## Quick Start

```bash
cd infra
sh start.sh
```

Open http://localhost:3000 (participant) or http://localhost:3003 (admin dashboard).

See [docs/getting-started.md](docs/getting-started.md) for prerequisites, ports, and a full pilot walkthrough.

## Documentation

| Document | Description |
|---|---|
| [Getting Started](docs/getting-started.md) | Prerequisites, running locally, configuration, useful commands |
| [Architecture](docs/architecture.md) | Services, data flow, session lifecycle, design decisions |
| [Bot Rulebook](docs/bot-rulebook.md) | Intervention logic: 2x2 conditions, contribution scoring, thresholds, message templates |
| [Pilot Checklist](docs/pilot-checklist.md) | Step-by-step verification for local pilot runs |

## Current Deferrals

- Final task specification and scoring (NASA/Mars exercise)
- Semantic/LLM-based contribution classifier
- No-intervention baseline condition (5th arm)
- Typing-speed and tab-visibility telemetry
- Matrix appservice registration for the bot
