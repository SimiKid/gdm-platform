# Deployment

Production runbook for `gdmproject.ifi.uzh.ch` (Debian 13 VM, 4 vCPU, 8 GB RAM,
10 GB `/var`, Docker preinstalled). SSH as `deployer` is key-based and only
reachable via UZH VPN; ports 80/443 are open to the public internet.

## Topology

```
Internet ──► Caddy :80/:443 (TLS via Let's Encrypt)
              ├── /_matrix/*  ─► Synapse            (registration answers 403)
              ├── /api/*      ─► Session Manager
              └── /*          ─► Participant SPA
VPN + SSH ──► 127.0.0.1:3003 ─► Admin Dashboard     (never public)
```

- App images are built by [GitHub Actions](../.github/workflows/build-images.yml)
  and pulled from GHCR — **the VM never builds** (keeps `/var` small).
- Matrix accounts are registered server-side by the Session Manager over the
  internal Docker network; Caddy blocks the public registration endpoints.
- Secrets live only in `infra/.env` on the server. Synapse cannot read env
  vars, so `render-homeserver.sh` bakes them into `homeserver.prod.yaml`
  (gitignored) from the template.

## First-time setup

1. **Clone the repo** (as `deployer`):
   ```bash
   git clone https://github.com/SimiKid/gdm-platform.git ~/gdm-platform
   cd ~/gdm-platform/infra
   ```

2. **Create `infra/.env`** from `.env.example` and set the production values:
   - `GDM_ENV=production` (backends refuse to start misconfigured otherwise)
   - `SYNAPSE_SERVER_NAME=gdmproject.ifi.uzh.ch` — **immutable after the
     first Synapse start**; it is baked into every Matrix user ID and the
     signing key. Triple-check before step 5.
   - `MATRIX_PUBLIC_URL=https://gdmproject.ifi.uzh.ch` and
     `PARTICIPANT_PUBLIC_URL=https://gdmproject.ifi.uzh.ch`
   - `PUBLIC_HOST=gdmproject.ifi.uzh.ch`, `ACME_EMAIL=<your address>`
   - Fresh `SYNAPSE_DB_PASSWORD` / `RESEARCH_DB_PASSWORD` — never the dev
     defaults (they are in the git history)
   - `ADMIN_API_TOKEN` / `INTERNAL_API_TOKEN`: `openssl rand -hex 32` each

3. **Log in to GHCR** (needed while the packages are private; a GitHub
   personal access token with `read:packages` suffices):
   ```bash
   docker login ghcr.io -u <github-user>
   ```

4. **Render the Synapse config** and check the output:
   ```bash
   sh render-homeserver.sh   # must print server_name: gdmproject.ifi.uzh.ch
   ```

5. **First start**:
   ```bash
   sh deploy.sh
   ```
   Caddy obtains the certificate on the first request; the Prisma migrations
   run automatically inside the session-manager container.

6. **Verify**:
   ```bash
   curl -fsS https://gdmproject.ifi.uzh.ch/api/health   # {"status":"ok"}
   curl -fsS https://gdmproject.ifi.uzh.ch/_matrix/client/versions
   # registration must be blocked:
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://gdmproject.ifi.uzh.ch/_matrix/client/v3/register   # 403
   ```
   Then open https://gdmproject.ifi.uzh.ch and run one manual session against
   the [pilot checklist](pilot-checklist.md).

## Updating

Merge to `main` → the workflow pushes fresh images → then, on the VM:

```bash
cd ~/gdm-platform && git pull && sh infra/deploy.sh
```

`git pull` updates compose files/Caddyfile/templates; `deploy.sh` re-renders
the Synapse config, pulls images and restarts changed containers. Database
data lives in named volumes and survives all of this.

## Rollback

Every workflow run also tags images with the git sha:

```bash
IMAGE_TAG=<git-sha> sh infra/deploy.sh
```

If a migration was involved, restore the matching DB backup first (below).

## Admin dashboard access

The dashboard is not routed publicly. From a machine on the UZH VPN:

```bash
ssh -L 3003:localhost:3003 deployer@gdmproject.ifi.uzh.ch
```

Then open http://localhost:3003 and enter the `ADMIN_API_TOKEN`.

## Backup & restore

The state worth protecting: both Postgres volumes (+ Synapse media).

```bash
cd ~/gdm-platform/infra
C="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"
# research data (sessions, surveys, chat log)
$C exec -T research-db pg_dump -U gdm gdm_research > backup-research-$(date +%F).sql
# matrix homeserver
$C exec -T synapse-db pg_dump -U synapse synapse > backup-synapse-$(date +%F).sql
```

Copy backups off the VM (`scp` from your machine — `/var` is small). During
an active study, run this daily (cron) and before every deploy.

Restore into a fresh volume: `$C exec -T research-db psql -U gdm gdm_research < backup-….sql`.

## Disk space (/var is 10 GB)

- `deploy.sh` prunes superseded images on every run.
- Check with `df -h /var` and `docker system df`.
- If tight: `docker system prune -f` (keeps volumes), and move old backups off
  the VM. Never `prune --volumes` — that deletes the databases.

## Troubleshooting

| Symptom | Check |
|---|---|
| Containers restart-looping | `$C logs session-manager` — fail-fast lists missing .env values |
| No certificate | `$C logs caddy` — port 80 must be reachable from the internet for ACME |
| Participant sees connection errors | `curl https://…/api/health`, `$C ps` (healthchecks) |
| Synapse refuses to start | server_name changed after first start? Must match the original |
| Session Manager can't reach DB | `$C logs research-db`, password in .env vs. first-init mismatch |

A wrong `SYNAPSE_SERVER_NAME` discovered **before** any real study data:
`$C down --volumes` (destroys all data), fix `.env`, re-render, redeploy.
