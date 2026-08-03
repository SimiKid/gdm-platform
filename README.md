# GDM Platform

A study platform for researching AI-supported group decision-making. Groups discuss a shared task in a real-time chat environment while a rule-based bot monitors contribution balance and intervenes when participation becomes uneven.

The project investigates whether in-the-moment AI nudges can improve both decision quality and group experience, using a 2x2 between-subjects design (public/private x neutral/engaging) plus a no-intervention baseline.

## Repository Structure

```
packages/shared/          Shared TypeScript types, DTOs, and defaults
backend/session-manager/  Matchmaking, session state, conditions, surveys, exports (NestJS + Prisma)
backend/chat-service/     Bot runtime: Matrix sync, message recording, intervention rules (NestJS)
frontend/participant/     Participant study flow: recruiting, survey, chat, exit survey (React)
frontend/admin-dashboard/ Researcher dashboard for conditions and exports (React)
e2e/                      Playwright end-to-end suite against the compose stack
infra/                    Docker Compose stack (dev + prod), Synapse config, Caddyfile, deploy script
docs/                     Architecture, bot rulebook, testing, pilot checklist
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
| [Bot Rulebook](docs/bot-rulebook.md) | Intervention logic: 2x2 conditions + baseline, contribution scoring, thresholds, and generated nudge wording |
| [Data Export](docs/data-export.md) | All export endpoints, JSON structures, and CSV column reference for researchers |
| [Testing](docs/testing.md) | Test strategy: unit / integration / e2e layers, how to run them, conventions |
| [Pilot Checklist](docs/pilot-checklist.md) | Step-by-step verification for local pilot runs |
| [Deployment](docs/deployment.md) | Production runbook: first-time setup, updates, rollback, backups |

## Current Deferrals

- Purely LLM-triggered interventions (the classifier only feeds the dominance score and invite grace; nudges stay window-triggered)
- Matrix appservice registration for the bot
