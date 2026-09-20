# Etherpad study mode

Use **Admin → Settings → Etherpad workspace → Enable Etherpad**. The switch is
global and saved in the research database. All study arms use it for new arrivals.
The dashboard shows a spinner and disables changes while the editor starts or
stops; the API also rejects study-setting changes during these transitions.
Startup failures become a visible error with a retry button after 90 seconds.

Each participant's mode is fixed when they enter the study, before the entry
questionnaire/task. Participants with different modes never share a waiting room.
Existing sessions retain their configuration. With Etherpad off, participants
keep the structured ranking, questionnaires, Matrix chat and existing exports.
The ranking path does not require a working Etherpad connection.

With Etherpad on:

- Entry task: a new, private, blank pad with a server-timed five-minute deadline.
- Group discussion: a separate, shared blank pad for that session, available for
  the existing discussion duration. Matrix remains the discussion channel.
- Exit task: a new, private, blank pad with a server-timed two-minute deadline.
- Entry and exit questionnaires retain their five-minute limits and partial
  submission on expiry. Refreshing a writing task reuses its pad and deadline.
- Ranking error scores are null/blank and ranking-order exports omit these
  sessions. Chat contribution measures and bot interventions remain chat-based.

## Switching off during a study

New arrivals immediately use ranking. Already admitted writing participants
finish in Etherpad; the dashboard shows **draining** and their count. The editor
stops after their writing has finished or their admissions have expired and all
created pads have been captured. Entry admissions expire after 30 minutes;
joining a group extends this to the discussion duration plus 20 minutes for
waiting/exit. A failed capture prevents shutdown and is retried automatically.
Enabling again during draining reuses the running server.

The editor is a child process of a small supervisor inside the Etherpad container.
The actual Etherpad server stops; the supervisor and its PostgreSQL database stay
up to accept a later start and preserve data. No Docker socket or privileged
container is exposed to the application. Run one Session Manager instance: its
serialized admission/lifecycle coordinator assumes a single writer.

## Content and limits

Every pad is limited to **1,000 Unicode code points**, including spaces and line
breaks. Emoji composed from several code points consume several characters.
Etherpad's internal terminal newline is excluded. Tabs are normalized by Etherpad
to spaces. The limit is checked against the merged document at the revision
boundary, so concurrent editors cannot each add 1,000 characters. An over-limit
edit is rejected; the client explains this and reloads the last accepted text.
The editor displays a live count. Socket payloads are limited to 16 KiB and pads
to 10,000 revisions as additional bounds on editing history.

Manual submit waits for the browser's pending edits to be acknowledged before
closing the pad. At the deadline, the server rejects further changes and captures
the accepted content, including partial or empty responses. Offline edits that
never reached the server before the deadline cannot be included. Capture waits
for pending database writes and persists raw plain text, revision and timestamp
in the research database. Captured pads are closed and cannot be reopened for
writing. A failed save presents a retry instead of silently advancing.

Pad access uses signed, expiring grants bound to one pad and a participant author.
Private pads require their owner's study token; group pads require membership.
Grants reach the iframe in its URL fragment and authenticate the Socket.IO
handshake. Access logging is disabled for this proxy route because that handshake
carries the grant in its query string. Keep query strings redacted if adding an
upstream access logger.
Public proxy routes expose the editor assets and collaboration socket only;
Etherpad admin, API, import/export, timeslider and control routes are not exposed.

## Exports and backups

`/api/export/etherpad` and `/api/export/etherpad.csv` are admin-only. They contain
raw text plus phase, capture state, deadline, revision and pseudonymous participant/
session/pad identifiers. The JSON export preserves text exactly; CSV applies the
project's existing formula-injection escaping. Filters match the other research
exports. Unmatched entry pads appear in unfiltered downloads with no session ID.
An open/failed pad has null text, distinguishable from a captured empty string.

Both research ZIP downloads include `etherpad.csv` when the selection contains
pad records. Full raw JSON exports include an `etherpads` array in that case.
Existing Matrix message exports remain present. No pad access grants or study
tokens are included in the Etherpad research export.

`infra/backup.sh` backs up Etherpad's PostgreSQL database after its first
deployment, alongside research and Matrix data. Restore the matching database
set together. Research snapshots remain readable when the editor is stopped.
To restore Etherpad's dump, use `pg_restore --clean --if-exists --no-owner
--no-privileges -U etherpad -d etherpad` inside the `etherpad-db` service, as part
of the existing deployment restore procedure with the application stopped.

## Local use and deployment

The local mock stack includes Etherpad automatically:

```powershell
.\infra\start-local.ps1
```

Etherpad starts disabled. Open the dashboard at `http://localhost:3003` to enable
it. Prolific and Anthropic mocks do not mock Etherpad, PostgreSQL or Matrix.

Before the first production deployment, set **distinct random secrets** in
`infra/.env` for `ETHERPAD_CONTROL_TOKEN` and `ETHERPAD_DB_PASSWORD`. The production
overlay requires them. Deploy the new database migration and the five app images
together using the existing deployment procedure. Etherpad and its control port
are internal to the Compose network; only the participant proxy is public.

The integration is pinned to Etherpad 3.3.5. Its image build verifies the exact
source integration points and fails on incompatible upstream changes. Upgrade
the version deliberately and run the editor tests, including simultaneous edits.

```powershell
node --test infra/etherpad/policy.test.cjs
$env:E2E_ETHERPAD = '1'
pnpm --filter @gdm/e2e exec playwright test tests/etherpad.spec.ts
```

The browser test changes the global workspace switch and only accepts a local
API target. Run it against a disposable/local mock study, not active recruitment.
