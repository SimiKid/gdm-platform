## Summary

Local development environment with Matrix Synapse homeserver and a React participant frontend, fully containerized via Docker Compose.

## Tech Stack

| Layer | Technology |
|---|---|
| Chat server | [Matrix Synapse](https://github.com/element-hq/synapse) (v1.155) |
| Database | PostgreSQL 16 (Alpine) |
| Frontend | React 19 + TypeScript 6 + Vite 8 |
| Matrix SDK | [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) v41.8.0 |
| Frontend server | Nginx (Alpine) with reverse proxy to Synapse |
| Package manager | pnpm (workspace) |
| Containerization | Docker Compose (3 services) |

## Architecture

```
localhost:3000 (nginx)
  ├── /            → React SPA
  └── /_matrix/*   → proxy to Synapse

localhost:8008 (synapse)
  └── PostgreSQL (internal, not exposed)
```

## How to run locally

```bash
# 1. Create .env from template
cp infra/.env.example infra/.env

# 2. Start all services
cd infra
docker compose up --build
```

Services are ready when `gdm-synapse` logs `Synapse now listening on TCP port 8008`.

## How to test

### 1. Register two test users

```bash
curl -s -X POST http://localhost:8008/_matrix/client/r0/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"test1234","auth":{"type":"m.login.dummy"}}'

curl -s -X POST http://localhost:8008/_matrix/client/r0/register \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"test1234","auth":{"type":"m.login.dummy"}}'
```

Save the `access_token` from each response.

### 2. Create a study room and join both users

```bash
# Create room as alice (use alice's token)
curl -s -X POST http://localhost:8008/_matrix/client/r0/createRoom \
  -H "Authorization: Bearer <ALICE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Study Group A","preset":"public_chat","room_alias_name":"study-group-a"}'

# Join as bob (use bob's token)
curl -s -X POST "http://localhost:8008/_matrix/client/r0/join/%23study-group-a%3Alocalhost" \
  -H "Authorization: Bearer <BOB_TOKEN>" \
  -H "Content-Type: application/json" -d '{}'
```

### 3. Open the frontend

**Dev login:** Open http://localhost:3000 in two browser windows, login with `alice`/`bob`.

**Magic link (study flow):** Open directly with the access tokens — no login screen:

```
http://localhost:3000/?token=<ALICE_TOKEN>
http://localhost:3000/?token=<BOB_TOKEN>
```

### 4. Verify

- Sidebar shows "Study Group A"
- Own messages appear on the **left** (blue), others on the **right** (white)
- Messages arrive in real-time across both windows
- Magic link strips the token from the URL after login

## Configuration

All config lives in `infra/.env` (see `.env.example`). The Synapse `homeserver.yaml` DB credentials must match the `.env` values manually (Synapse reads static YAML, not env vars).

| Setting | Purpose |
|---|---|
| `SYNAPSE_SERVER_NAME` | Matrix server name (`localhost` for dev) |
| `SYNAPSE_DB_PASSWORD` | Must match `homeserver.yaml` `password` field |
| `VITE_MATRIX_HOMESERVER` | Frontend env var for Synapse URL (defaults to `http://localhost:8008`) |
