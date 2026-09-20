# Deployment

Production runbook for `gdmproject.ifi.uzh.ch` (Debian 13 VM, 4 vCPU, 8 GB RAM,
10 GB `/var`, Docker preinstalled). SSH as `deployer` is key-based and only
reachable via UZH VPN; ports 80/443 are open to the public internet.

## Topology

```
Internet ──► Caddy :80/:443 (TLS via Let's Encrypt)
              ├── /_matrix/*  ─► Synapse            (register/login/createRoom/invite → 403,
              │                                      federation + key endpoints → 404, 2 MB body cap)
              ├── /api/*      ─► Session Manager    (512 KB body cap; internal recover/checkpoint/finalize → 404)
              ├── /admin/*    ─► Admin Dashboard     (UZH network + API token)
              └── /*          ─► Participant SPA
VPN + SSH ──► 127.0.0.1:3003 ─► Admin Dashboard     (fallback)
```

- App images are built by [GitHub Actions](../.github/workflows/build-images.yml)
  and pulled from GHCR — **the VM never builds** (keeps `/var` small). The
  workflow's `verify` job (lint, build, unit tests, advisory audit,
  integration tests) must pass before the `build` job pushes images.
- Matrix accounts are registered server-side by the Session Manager over the
  internal Docker network; Caddy blocks the public registration, login,
  room-creation and invite endpoints.
- Secrets live only in `infra/.env` on the server. Synapse cannot read env
  vars, so `render-homeserver.sh` bakes them into `homeserver.prod.yaml`
  (gitignored) from the template.

Commands below use `$C` as shorthand for the production compose invocation.
Define it once per shell on the VM:

```bash
cd ~/gdm-platform/infra
C="docker compose --env-file .env -f docker-compose.yml -f docker-compose.prod.yml"
```

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
   - `ADMIN_API_TOKEN` / `INTERNAL_API_TOKEN`: `openssl rand -hex 32` each.
     In production the Session Manager refuses to start unless both are at
     least 32 characters long; the Chat Service checks `INTERNAL_API_TOKEN`.
   - `MATRIX_SERVICE_PASSWORD`: another generated secret (≥ 32 characters,
     and not the dev default — the Session Manager checks both). It
     authenticates the stable Matrix room owner used to re-invite a bot after
     service restarts.
   - Add `ANTHROPIC_API_KEY` for fresh nudge wording and Rule+LLM detection,
     and keep the pinned `ANTHROPIC_MODEL`. Leave `LLM_MODE` empty so each
     condition's own `llmMode` applies. The key is read only by
     `chat-service`, which refuses to start in production without it.
     `MODERATION` (default `off`) may be set to `on` to enable LLM moderation
     of participant messages; it uses the same key.
   - For API-validated Prolific recruitment, set the draft's 24-character
     `PROLIFIC_STUDY_ID`, a researcher **API token** in
     `PROLIFIC_API_TOKEN`, and `PROLIFIC_REQUIRE_VALIDATION=true`. The token
     is what switches API validation on; the `REQUIRE` flag makes a production
     start fail if id or token are missing. This validates anyone claiming
     Prolific identity while still allowing direct/generic participants,
     which are recorded separately as `recruitment_source=direct`.
   - Set `WAITING_TIMEOUT_MINUTES=5`,
     `PARTICIPANT_RECONNECT_GRACE_SECONDS=30`,
     `PARTIAL_PAYMENT_PENCE_PER_MINUTE=10`, and
     `PARTIAL_PAYMENT_MAX_PENCE=508` for the current study. Set
     `PROLIFIC_AUTO_RETURN_DISCONNECTS=true` to notify Prolific when a browser
     misses the reconnect window; keep `PROLIFIC_PAYMENT_AUTOMATION=false` so
     every partial bonus remains a researcher-reviewed action.

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
   Caddy obtains the certificate for `PUBLIC_HOST` when it starts; the Prisma
   migrations run automatically inside the session-manager container.
   `deploy.sh` refuses to run unless `.env` sets `GDM_ENV=production`, backs
   up first, waits for the two databases, Synapse, Session Manager and Chat
   Service to report healthy (or running, where no healthcheck exists), and
   ends with a readiness check.

6. **Verify**:
   ```bash
   curl -fsS https://gdmproject.ifi.uzh.ch/api/health/ready
   curl -fsS https://gdmproject.ifi.uzh.ch/_matrix/client/versions
   # registration must be blocked:
   curl -s -o /dev/null -w '%{http_code}\n' \
     https://gdmproject.ifi.uzh.ch/_matrix/client/v3/register   # 403
   ```
   Then open https://gdmproject.ifi.uzh.ch and run one manual session against
   the [pilot checklist](pilot-checklist.md).

7. **Before recruiting — set every completion/exit path and the study URL**:
   - In the admin dashboard, Settings → **Prolific completion and exit paths**,
     set the normal completion URL plus the consent-decline, ineligible,
     withdrawal, unmatched, and technical-failure URLs created in Prolific.
     There is no environment-variable fallback. Empty early-exit URLs stop
     safely and direct the participant to contact the researcher.
   - Select Prolific's URL-parameter recording and use its standard external
     study URL (Prolific may append these parameters automatically):
     `https://gdmproject.ifi.uzh.ch/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`.
     When `PROLIFIC_REQUIRE_VALIDATION=true`, the backend verifies that the
     submission, participant, and configured study match before admitting a
     participant as `recruitment_source=prolific`. Requests without Prolific
     parameters remain normal direct participants; incomplete parameter sets
     are rejected by the frontend instead of silently becoming direct.
   - Confirm the completion code in Prolific exactly matches the completion
     URL stored in Admin → Settings. Keep submission processing on manual
     review and keep `PROLIFIC_PAYMENT_AUTOMATION=false` until the exit-path
     pilot and admin compensation queue have both been checked.
   - Verify the participant can refresh within 30 seconds, while a longer
     disconnect records `connection_timeout`, releases/kicks the participant,
     requests a Prolific return, and leaves any partial amount in the admin
     queue without paying it automatically.

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
DB. The application excludes `e2e-` conditions from every research export
and from the round counters automatically, so no manual filtering is needed.

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

This is bounded by the machine running the browsers (3 participant Chromium
contexts plus one admin context per session), not the server — beyond ~5–10
parallel sessions you are measuring your laptop. Every run leaves one more
test session in the research DB.

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

A changed `homeserver.prod.yaml.template` needs no manual Synapse restart:
`deploy.sh` stores the rendered config's SHA-256 in a container label
(`gdm.synapse-config-sha`), so `up -d` recreates Synapse exactly when its
configuration changed.

Prisma migrations run automatically before Session Manager startup
(`prisma migrate deploy` in the image's `CMD`). Migrations are
**forward-only** and not all of them are additive: the study-rounds migration
(`20260801000000_study_rounds`) creates a `study_rounds` table, backfills a
Round 1 row, and adds a `NOT NULL` `round_id` column (default 1, foreign key
to `study_rounds`) to `sessions`. `deploy.sh` now runs `backup.sh` before every image pull or
migration and refuses to continue if only part of the persistent stack can be
backed up.

## Enabling Anthropic nudge wording and classification

1. Create an API key in the Anthropic Console and fund/enable the workspace.
2. Put `ANTHROPIC_API_KEY=...` in the VM's `infra/.env`; never commit it.
3. Keep `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` for reproducible results.
4. Redeploy the chat service. Every non-baseline intervention then gets fresh
   nudge wording, and both nudging arms (`llmMode: "active"`) classify
   messages automatically. `LLM_MODE=off` disables semantic detection but not
   generated wording; `LLM_MODE=active` forces the classifier on everywhere.
   Production startup fails fast if the key is missing. Runtime API failures
   use validated fixed fallback wording so they do not suppress a nudge.
5. Run a fake pilot and fetch the contributions export
   (`GET /api/export/contributions`, URL-only) or the Overview tab's Full
   data dump. Confirm the meaningfulness classifications before recruitment.

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

From an allowed UZH network or the Remote Access VPN, open
https://gdmproject.ifi.uzh.ch/admin/ and enter `ADMIN_API_TOKEN` (the
dashboard keeps it in the browser's `localStorage` under `gdm-admin-token`).
Caddy rejects both the dashboard shell and the researcher-only API routes
(`/api/admin*`, `/api/conditions*`, `/api/interventions`, `/api/export/*`,
`/api/reports*`, `/api/rounds*`, `/api/settings`, and `GET /api/sessions`)
from other source networks with 403. The Session Manager still requires the
token as a second layer; network access alone never authorizes a researcher
request.

The allowlist lives in `infra/Caddyfile`. It includes the UZH institutional,
VPN, guest, Eduroam and supplied internal address ranges. The guest range is
represented by `185.207.116.0/22` plus `185.207.120.0/24`, covering the complete
stated interval `185.207.116.0-185.207.120.255`.

The original SSH-tunnel route remains available as a fallback from a machine
on the UZH VPN:

```bash
ssh -L 3003:localhost:3003 deployer@gdmproject.ifi.uzh.ch
```

Then open http://localhost:3003 and enter the same token.

## Backup & restore

The state worth protecting is both Postgres databases plus Synapse's signing
key/media volume. Every deployment with a running stack creates and verifies
a complete backup set (on a fresh VM with no databases yet, `backup.sh` exits
without producing one):

```bash
cd ~/gdm-platform/infra
sh backup.sh
ls -lh backups/
```

The script reads the actual database names from `.env`, uses restrictive file
permissions, validates both custom-format PostgreSQL archives with
`pg_restore --list`, verifies the Synapse gzip archive, and writes portable
SHA-256 checksums. It does not delete old sets automatically. Copy every new
set off the VM (`scp` from your machine — `/var` is small). During active
collection, also schedule `backup.sh` daily and monitor available disk space.

Verify a copied set from inside its directory:

```bash
sha256sum -c checksums-<timestamp>.sha256
```

Restore a database archive into an empty database (replace names from `.env`):

```bash
$C exec -T research-db pg_restore --clean --if-exists --no-owner \
  -U gdm -d gdm_research < research-<timestamp>.dump
```

## Disk space (/var is 10 GB)

- `deploy.sh` prunes superseded images on every run.
- Check with `df -h /var` and `docker system df`.
- If tight: `docker system prune -f` (keeps volumes), and move old backups off
  the VM. Never `prune --volumes` — that deletes the databases.

## Troubleshooting

| Symptom | Check |
|---|---|
| Containers restart-looping | `$C logs session-manager` / `$C logs chat-service` — fail-fast lists the offending .env values (short tokens, dev Matrix password, localhost `MATRIX_PUBLIC_URL`, missing or empty `MATRIX_PUBLIC_URL`, missing `ANTHROPIC_API_KEY`, `PROLIFIC_REQUIRE_VALIDATION=true` without study id/token, `PROLIFIC_PAYMENT_AUTOMATION=true` without token) |
| No certificate | `$C logs caddy` — port 80 must be reachable from the internet for ACME |
| Participant sees connection errors | `curl https://…/api/health`, `$C ps` (healthchecks) |
| Synapse refuses to start | server_name changed after first start? Must match the original |
| Session Manager can't reach DB | `$C logs research-db`, password in .env vs. first-init mismatch |

A wrong `SYNAPSE_SERVER_NAME` discovered **before** any real study data:
`$C down --volumes` (destroys all data), fix `.env`, re-render, redeploy.

## Etherpad workspace

The stack now includes the pinned Etherpad image and its persistent PostgreSQL database. Before deploying this version, configure `ETHERPAD_CONTROL_TOKEN` and `ETHERPAD_DB_PASSWORD` in `infra/.env`. Start/stop is controlled from Admin → Settings. See [Etherpad study mode](etherpad.md) for setup, draining active studies, access control, testing and backup/restore details.
