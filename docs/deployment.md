# Deployment

Production runbook for `gdmproject.ifi.uzh.ch` (Debian 13 VM, 4 vCPU, 8 GB RAM,
10 GB `/var`, Docker preinstalled). SSH as `deployer` is key-based and only
reachable via UZH VPN; ports 80/443 are open to the public internet.

## Topology

```
Internet ──► Caddy :80/:443 (TLS via Let's Encrypt)
              ├── /_matrix/*  ─► Synapse            (registration answers 403)
              ├── /api/*      ─► Session Manager
              ├── /admin/*    ─► Admin Dashboard     (API token required)
              └── /*          ─► Participant SPA
VPN + SSH ──► 127.0.0.1:3003 ─► Admin Dashboard     (fallback)
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
   - `MATRIX_PUBLIC_URL=https://gdmproject.ifi.uzh.ch`. Note
     `PARTICIPANT_PUBLIC_URL` is **baked into the admin-dashboard image at CI
     build time** (set in `.github/workflows/build-images.yml`) — setting it in
     the VM's `.env` has no effect in production, because the prod compose file
     pulls prebuilt images. Changing the public host means editing the workflow
     and rebuilding.
   - `PUBLIC_HOST=gdmproject.ifi.uzh.ch`, `ACME_EMAIL=<your address>`
   - Fresh `SYNAPSE_DB_PASSWORD` / `RESEARCH_DB_PASSWORD` — never the dev
     defaults (they are in the git history)
   - `ADMIN_API_TOKEN` / `INTERNAL_API_TOKEN`: `openssl rand -hex 32` each
   - `MATRIX_SERVICE_PASSWORD`: another generated secret. It authenticates the
     stable Matrix room owner used to re-invite a bot after service restarts.
   - For the Rule+LLM detection arms, add `ANTHROPIC_API_KEY` and keep the
     pinned `ANTHROPIC_MODEL`. Leave `LLM_MODE` empty so each condition's
     own detection arm applies. The key is read only by `chat-service`.

3. **Log in to GHCR** (needed while the packages are private; a GitHub
   personal access token with `read:packages` suffices):
   ```bash
   docker login ghcr.io -u <github-user>
   ```

4. **Render the Synapse config** and check the output:
   ```bash
   sh render-homeserver.sh   # must print "(server_name: gdmproject.ifi.uzh.ch)"
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

7. **Before recruiting — set the compensation link and the study URL**:
   - In the admin dashboard, Settings → **Compensation Link** must be set to
     the Prolific completion URL. There is no environment-variable fallback in
     the deployed images — without this setting, participants reach the
     debriefing page with a dead link.
   - The Prolific study URL must pass the Prolific participant id as the
     tracking token: `https://gdmproject.ifi.uzh.ch/?p={{%PROLIFIC_PID%}}`.
     Without `?p=`, the participant gets a random self-issued token and the
     exported `tracking_token` cannot be matched to a Prolific submission
     (which is what `linkage.csv` is for).

## Smoke test (e2e against production)

The production-safe Playwright profile can run against the live stack after a
deploy or before opening recruitment. With the SSH tunnel (below) open, from
your machine:

```bash
E2E_PARTICIPANT_URL=https://gdmproject.ifi.uzh.ch \
E2E_SESSION_MANAGER_URL=https://gdmproject.ifi.uzh.ch/api \
E2E_ADMIN_URL=http://localhost:3003 \
E2E_ADMIN_TOKEN=<ADMIN_API_TOKEN from the server .env> \
pnpm --dir e2e exec playwright test
```

The run provisions its own `e2e-…` condition (grouped as test residue in the
dashboard, deactivated afterwards) and leaves its session data in the research
DB — exclude `e2e-` conditions when exporting study data.

Run the separately gated live Anthropic check with the same environment:

```bash
E2E_PARTICIPANT_URL=https://gdmproject.ifi.uzh.ch \
E2E_SESSION_MANAGER_URL=https://gdmproject.ifi.uzh.ch/api \
E2E_ADMIN_URL=http://localhost:3003 \
E2E_ADMIN_TOKEN=<ADMIN_API_TOKEN from the server .env> \
pnpm --dir e2e test:e2e:live
```

Do not run `test:e2e:recovery` against production. It deliberately controls a
local Compose stack; production recovery is exercised during a planned deploy
and verified with the production-safe profile.

For a light load probe before opening recruitment, repeat and parallelise the
run — each worker provisions its own condition, so parallel sessions cannot
cross-match:

```bash
E2E_… pnpm --dir e2e exec playwright test tests/golden-path.spec.ts --repeat-each=10 --workers=5
```

(`--workers=5` deliberately overrides the checked-in `workers: 1` safety
default — that default exists because Matrix rooms and temporary conditions
are shared server-side resources; the per-worker conditions here make the
override safe.)

This is bounded by the machine running the browsers (3 Chromium contexts per
session), not the server — beyond ~5–10 parallel sessions you are measuring
your laptop. Every run leaves one more test session in the research DB.

## Study rounds in production

Starting a new round (Settings → Study Rounds → Start Round N) is a
participant-visible action: it **aborts every waiting lobby immediately**
(participants in a waiting room are dropped) and resets each arm's recruiting
progress to 0 / goal. Treat it like a deploy: do it between sessions, never
while recruitment is actively filling lobbies. Running discussions are not
touched — they finish in their round.

## Updating

Do not deploy while a discussion is active. Runtime checkpoints make an
unexpected restart recoverable, but a planned update should still happen
between sessions.

Merge to `main` → the workflow pushes fresh images → then, on the VM:

```bash
cd ~/gdm-platform && git pull && sh infra/deploy.sh
```

`git pull` updates compose files/Caddyfile/templates; `deploy.sh` re-renders
the Synapse config, pulls images and restarts changed containers. Database
data lives in named volumes and survives all of this.

If a release changes `homeserver.prod.yaml.template`, restart Synapse once
after `deploy.sh` so the bind-mounted configuration is reloaded:

```bash
cd ~/gdm-platform/infra
docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml restart synapse
```

Prisma migrations run automatically before Session Manager startup
(`prisma migrate deploy` in the container entrypoint). Migrations are
**forward-only** and not all of them are additive: the study-rounds migration
(`20260801000000_study_rounds`) creates a `study_rounds` table, backfills a
Round 1 row, and adds a `NOT NULL` `round_id` column with a foreign key to
`sessions`. Take a database backup before any deploy that carries a new
migration.

## Enabling the Anthropic classifier (Rule+LLM arms)

1. Create an API key in the Anthropic Console and fund/enable the workspace.
2. Put `ANTHROPIC_API_KEY=...` in the VM's `infra/.env`; never commit it.
3. Keep `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` for reproducible results.
4. Redeploy the chat service. The Rule+LLM conditions (`llmMode: "active"`)
   then classify messages automatically. `LLM_MODE=off` is an emergency
   global kill switch; `LLM_MODE=active` forces every arm to Rule+LLM.
5. Run a fake pilot and download **Contributions & behavioral telemetry**.
   Confirm the meaningfulness classifications before recruitment.

The classifier sends pseudonymized participant labels plus chat text to
Anthropic and records model, prompt, raw output, and decisions.
Consent/data-processing approval must cover the external API first.

## Rollback

Every workflow run also tags images with the **short** commit sha (7 chars,
`git rev-parse --short=7 <commit>`, shown in the Actions run):

```bash
IMAGE_TAG=<short-sha> sh infra/deploy.sh
```

If a migration was involved, **restore the matching DB backup first** (below) —
re-pinning the image tag alone is not enough. Prisma has no down migrations
here and does not check schema drift at runtime, so an older image will boot
against the newer schema with an outdated client (e.g. a pre-rounds image
against a schema whose `sessions.round_id` it does not know).

## Admin dashboard access

Open https://gdmproject.ifi.uzh.ch/admin/ and enter `ADMIN_API_TOKEN`. The
dashboard shell is public, but every researcher endpoint containing sessions,
settings or exports rejects requests without that token.

The original SSH-tunnel route remains available as a fallback from a machine
on the UZH VPN:

```bash
ssh -L 3003:localhost:3003 deployer@gdmproject.ifi.uzh.ch
```

Then open http://localhost:3003 and enter the same token.

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

The user/database names above are the `.env.example` defaults — if you changed
`RESEARCH_DB_USER`/`RESEARCH_DB_NAME` or `SYNAPSE_DB_USER`/`SYNAPSE_DB_NAME`,
use your values.

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
