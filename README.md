# GDM Platform

A study platform for researching AI-supported group decision-making. Groups discuss a shared task in a real-time chat environment while a rule-based bot monitors contribution balance and intervenes when participation becomes uneven.

The project investigates whether in-the-moment AI nudges can improve both decision quality and group experience, using a 2x2 between-subjects design (public/private delivery x rule-based/rule+LLM detection) plus a no-intervention baseline. Data collection is organized into numbered study rounds with per-round recruiting goals.

## Repository Structure

```
packages/shared/          Shared TypeScript types, DTOs, and defaults
backend/session-manager/  Matchmaking, session state, conditions, study rounds, surveys, reports/exports (NestJS + Prisma)
backend/chat-service/     Bot runtime: Matrix sync, message recording, intervention rules, LLM classifier (NestJS)
frontend/participant/     Participant study flow: recruiting, survey, chat, exit survey (React)
frontend/admin-dashboard/ Researcher dashboard: overview, results, settings (rounds, parameters), bot testing (React)
e2e/                      Playwright end-to-end suite against the compose stack
loadtest/                 k6 load-test harness (profiles, scripts, monitoring)
infra/                    Docker Compose stack (dev + prod), Synapse config, Caddyfile, deploy script
docs/                     Architecture, bot rulebook, data export, testing, deployment, pilot checklist
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
| [Prolific Integration](docs/prolific-integration.md) | Full Prolific study, account/API, URL parameter, completion-path, compensation, launch, and reconciliation runbook |
| [Load Testing](loadtest/README.md) | k6 load-test harness: profiles, run scripts, monitoring |

## Current Deferrals

- Purely LLM-triggered interventions — nudges stay window-triggered in all arms; in the rule+LLM arms the live classifier feeds the dominance score and invite grace, but never fires a nudge on its own
- Matrix appservice registration for the bot
