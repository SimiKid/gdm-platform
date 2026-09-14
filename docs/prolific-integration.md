# Prolific integration runbook

This document is the end-to-end setup and operations guide for recruiting
participants from Prolific into the GDM Platform. It covers the Prolific study
draft, account/API connection, URL parameters, completion paths, server and
admin settings, participant lifecycle, compensation, testing, launch, and
reconciliation.

The values in **Current production configuration** were verified on
2026-08-31. Re-check them before every launch and whenever a Prolific study is
duplicated: a duplicate study has a new `STUDY_ID`, and its completion codes and
redirect URLs may also be new.

## What the integration does

The application accepts both Prolific and direct participants:

- A URL containing all three standard Prolific parameters is treated as a
  Prolific submission and enters the validated lifecycle and compensation flow.
- A URL containing none of them remains a valid direct study link. The database
  records `recruitment_source=direct`; no Prolific API action or redirect is
  attempted.
- A URL containing only some of the three parameters is rejected. It never
  silently becomes a direct participant.

For a Prolific participant the application:

1. captures `PROLIFIC_PID`, `STUDY_ID`, and `SESSION_ID`;
2. removes them from the visible address bar;
3. verifies the submission against Prolific's API whenever
   `PROLIFIC_API_TOKEN` is configured (see section 6 for what
   `PROLIFIC_REQUIRE_VALIDATION` does and does not do);
4. records an arrival before consent, so early exits are reconcilable;
5. records progress through consent, entry survey, waiting room, chat, exit
   survey, and completion;
6. stores exactly one terminal outcome when the participant finishes or leaves;
7. displays the corresponding Prolific completion/return path; and
8. exposes audited return and partial-bonus actions in the admin dashboard.

The server, not the browser, assigns `recruitment_source`. With an API token
configured, supplying arbitrary JSON or a generic token cannot make a direct
participant a Prolific participant. Without a token (development, or a
misconfigured server) any well-formed identifiers are accepted and stored as
`recruitment_source=prolific` without verification — which is why production
must run with the token and `PROLIFIC_REQUIRE_VALIDATION=true`.

## Current production configuration

### Prolific study draft

| Setting | Current value |
| --- | --- |
| Study name | Group decision-making study |
| Internal name | GDM Prolific integration test |
| Data collection | External study link |
| Study label | Decision making |
| Device | Desktop only |
| Audio/camera/microphone/download | None |
| Content warning | None |
| Group size in the app | 3 participants |
| Estimated duration | 30 minutes |
| Prolific maximum time | 60 minutes, calculated by Prolific |
| Base reward | £5.08 |
| Repeat participation | Once |
| Exceptionally-fast auto-rejection | Off |
| Distribution | Standard sample |
| Simultaneous participant limit | 50 in the current draft |
| Custom screen-out slots | 5 |
| Screen-out reward | £0.10 |

The participant target, audience filters, simultaneous limit, duration, and
reward are launch decisions rather than application constants. Recruit in
multiples of the app's group size where practical. Prolific's simultaneous
participant limit controls how many people may enter the external study at
once; it is not the five-minute app waiting-room deadline and does not guarantee
that every entrant will be matched.

Current study description:

> You will work with two other participants in a timed online group discussion
> to complete a decision-making and ranking task. You will also answer brief
> questions before and after the discussion. Please use a desktop or laptop
> and be prepared to participate actively for the entire study.

### URL and IDs

Current external study URL:

```text
https://gdmproject.ifi.uzh.ch/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
```

Current production `STUDY_ID`:

```text
6a69fc8742750ae81af3d24a
```

### Completion paths

| Prolific path | Processing in Prolific | Code | Redirect URL | App admin field |
| --- | --- | --- | --- | --- |
| Default / full completion | Manually review | `CNE4B56C` | `https://app.prolific.com/submissions/complete?cc=CNE4B56C` | Full completion |
| No consent | Request a return | `CTIVG3MM` | `https://app.prolific.com/submissions/complete?cc=CTIVG3MM` | Consent declined |
| Screened out | Approve and pay the configured screen-out reward | `C18MTOGA` | `https://app.prolific.com/submissions/complete?cc=C18MTOGA` | Ineligible |
| Voluntary withdrawal | Request a return | `CJPQ7AG8` | `https://app.prolific.com/submissions/complete?cc=CJPQ7AG8` | Voluntary withdrawal |
| Group could not be formed | Request a return | `CEM434X8` | `https://app.prolific.com/submissions/complete?cc=CEM434X8` | Group not formed |
| Technical problem | Request a return | `C8SA2ZXR` | `https://app.prolific.com/submissions/complete?cc=C8SA2ZXR` | Technical/group failure |

Completion paths and partial bonuses are separate mechanisms. For example, the
"Group could not be formed" path requests that the base submission be returned;
the app separately records a time-based bonus for researcher review.

### Server values

```dotenv
PROLIFIC_STUDY_ID=6a69fc8742750ae81af3d24a
PROLIFIC_API_TOKEN=<configured server-side; never put the value in git>
PROLIFIC_REQUIRE_VALIDATION=true
WAITING_TIMEOUT_MINUTES=5
PARTICIPANT_RECONNECT_GRACE_SECONDS=30
PARTIAL_PAYMENT_PENCE_PER_MINUTE=10
PARTIAL_PAYMENT_MAX_PENCE=508
PROLIFIC_AUTO_RETURN_DISCONNECTS=true
PROLIFIC_PAYMENT_AUTOMATION=false
```

## 1. Link the Prolific account/workspace

The integration does not use OAuth. The Session Manager is linked to the
researcher's Prolific workspace with a server-only researcher API token.

1. Sign in to the correct Prolific researcher workspace.
2. Open **API Tokens** (depending on the current navigation, this may be under
   **Apps & Integrations** or researcher settings).
3. Create a new API token for the GDM production deployment.
4. Copy it immediately and store it in the server's secret management process.
5. Do not paste it into the Prolific study URL, either frontend, the admin
   dashboard, an issue, a log command, or this repository.
6. On the server, set it in `/home/deployer/gdm-platform/infra/.env`:

   ```dotenv
   PROLIFIC_API_TOKEN=<token>
   PROLIFIC_STUDY_ID=<24-character study id>
   PROLIFIC_REQUIRE_VALIDATION=true
   ```

7. Recreate the Session Manager through the normal deployment procedure so it
   receives the new environment. A simple browser refresh is not sufficient.
8. Confirm the container is healthy and that the token is present without
   printing the token itself:

   ```bash
   ssh masterproject \
     'docker inspect --format "{{range .Config.Env}}{{println .}}{{end}}" infra-session-manager-1 \
       | grep -q "^PROLIFIC_API_TOKEN=." && echo "Prolific API token configured"'
   ```

Prolific currently describes researcher API tokens as non-expiring and
full-permission credentials. Treat the token as a production secret. If it is
exposed, delete it in Prolific, create a replacement, update `infra/.env`, and
recreate the Session Manager.

## 2. Create or configure the Prolific study

### Study details

1. In Prolific, create an **External study link** study.
2. Enter a participant-facing name and an internal name that identifies the
   environment/round.
3. Describe the live group requirement, the need to remain for the whole task,
   and the supported device.
4. Select **Desktop** only. The app may render on smaller devices, but this
   study requires the desktop group-chat and ranking workflow.
5. Select the relevant study label (currently **Decision making**).
6. Configure content warnings and hardware requirements truthfully. The current
   study requires no audio, camera, microphone, or download.

### External URL and parameter recording

1. In **Data collection → What's the URL of your study?**, enter:

   ```text
   https://gdmproject.ifi.uzh.ch/
   ```

2. Under **Recording Prolific IDs**, select **URL parameters**.
3. Keep the standard, case-sensitive parameter names:

   ```text
   PROLIFIC_PID
   STUDY_ID
   SESSION_ID
   ```

4. Confirm that the final URL displayed by Prolific is exactly equivalent to:

   ```text
   https://gdmproject.ifi.uzh.ch/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}
   ```

Prolific normally appends these placeholders after URL-parameter recording is
selected. If the UI has already appended them, do not append a second copy.
All three values are required by this application. `SESSION_ID` is the Prolific
submission ID and is the value used for server-side API verification.

Do **not** enable Prolific's **Secure external URL**/JWT feature for this study.
The current integration validates the three normal query parameters by calling
the Prolific submission API; it does not yet verify Prolific's signed JWT URL.

### Participant access and release strategy

1. Set the participant target for the round. A minimal end-to-end live pilot is
   three people because the current app group size is three.
2. Prefer target/release sizes that are multiples of the group size.
3. Configure Prolific's simultaneous participant limit based on server capacity
   and the intended release wave. The current draft uses 50.
4. Remember that an incomplete final group will wait up to five minutes and
   then follow the unmatched/partial-compensation flow.
5. Apply the approved audience filters. No country filter is present in the
   current pilot draft.
6. Set **Total times a participant can complete your study** to **Once** unless
   the research design explicitly requires repeat participation.
7. Leave automatic exceptionally-fast rejection off unless the research team
   has adopted and documented a compliant review rule.

### Duration and reward

The current Prolific estimate is 30 minutes with a £5.08 base reward. The 30
minutes includes the consent and entry questions, the individual ranking task,
up to five minutes in the waiting room, the live group task, and the exit survey
and debrief. Prolific currently calculates a 60-minute maximum automatically.

Before each launch, verify the actual median from completed pilot submissions
and adjust the estimate/reward to comply with Prolific's current minimum and the
study's approved compensation plan. `PARTIAL_PAYMENT_MAX_PENCE` must not exceed
the intended full base reward unless the protocol explicitly allows that.

## 3. Configure screening

The app terminates eligibility on the About You page when a participant
reports:

- an age under 18 (checked when the age field loses focus, before Continue is
  pressed; ages above 120 are a validation error, not a screen-out); or
- English proficiency `None` (option value `none`, checked on selection).

It does not terminate `Basic` or `Intermediate` English responses. A
"prefer not to say" age response remains eligible in the current code. The
stored reasons are "The participant reported being younger than the minimum
age of 18." and "The participant reported no English proficiency for the live
group discussion."

To configure the current custom screening path in Prolific:

1. In **Data collection → Custom screening**, select **Yes**.
2. Budget enough screen-out slots for the anticipated launch (currently 5).
3. Set the screening reward (currently £0.10).
4. Create/use the **Screened out** completion path.
5. Select **Approve and pay** for that path.
6. Copy its redirect URL into **Admin dashboard → Settings → Prolific
   completion and exit paths → Ineligible**.

Prolific requires screened-out participants to receive the configured
screen-out reward. Do not map an eligibility failure to the no-consent path.
Consent decline is not a screening failure and uses a request-return/no-base-pay
path.

If Prolific prescreeners are used, follow Prolific's current validation rules:
use the exact prescreener wording and redirect mismatches through an appropriate
screen-out/return path. Keep research ethics and Prolific policy aligned with
any in-study eligibility question.

## 4. Create all completion paths in Prolific

Create every path before publishing. Changes made while submissions are active
can split participants across old and new processing rules.

### Default / full completion

1. In **Completion paths → Default**, select **Manually review** for the current
   workflow.
2. Copy the generated redirect URL and code.
3. Save the full URL in the app's **Full completion** field.

After the app has saved the exit survey and individual completion, the
participant acknowledges the debrief and follows this path. With manual review,
the Prolific submission becomes `AWAITING_REVIEW`; it is not paid merely because
the redirect was opened.

### No consent

1. Add a completion path, choose **Custom**, and label it **No consent**.
2. Select **Request a return**.
3. Save the URL in **Consent declined**.

The app records the outcome but deliberately does not show the withheld-purpose
debrief to someone who did not consent.

### Screened out

Use the custom-screening path described above and save its URL in
**Ineligible**. It should automatically approve and pay only the configured
screen-out reward, not the full base reward.

### Voluntary withdrawal

1. Add a **Custom** path named **Voluntary withdrawal**.
2. Select **Request a return**.
3. Save its URL in **Voluntary withdrawal**.

Before meaningful participation, the app records no compensation. From the
`entry` stage onward it records `manual_review`; the researcher decides whether
additional compensation is due. Note that the durable `entry` stage is only
recorded once the whole entry flow (About You, attitudes, ranking task, group
intro) has been completed, immediately before `waiting`; while the participant
is still inside those pages the stored stage is `consent`, so a withdrawal
there records `none`.

### Group could not be formed

1. Add a **Custom** path named **Group could not be formed**.
2. Select **Request a return**.
3. Save its URL in **Group not formed**.

The base submission is returned. The application separately calculates and
queues a partial bonus for the time spent.

### Technical problem

1. Add a **Custom** path named **Technical problem**.
2. Select **Request a return**.
3. Save its URL in **Technical/group failure**.

This handles connection timeouts, room-provisioning failures, participant
dropout, and group aborts. A partial bonus or manual review may be recorded
depending on the participant's stage.

Fallbacks when this field is empty: `technical_failure`,
`participant_dropout` and `group_aborted` fall back to the **Group not
formed** URL, and `connection_timeout` falls back to the **Voluntary
withdrawal** URL.

### Important redirect behavior

The app records the terminal outcome before displaying a redirect. Empty
early-exit URLs fail safely: the participant is told to keep the page open and
contact the researcher instead of receiving an incorrect code. The full
completion page differs: with an empty **Full completion** field it falls
back to the build-time `VITE_PAYMENT_URL` before showing the not-configured
message.

The application cannot observe whether a participant actually clicked a
Prolific redirect or whether Prolific already processed that completion path.
Before sending a second return request from the admin dashboard, compare the
app outcome with the submission's current state in Prolific.

## 5. Configure completion URLs in the app

1. Open `https://gdmproject.ifi.uzh.ch/admin/`.
2. Enter the separate `ADMIN_API_TOKEN` if requested. This is not the Prolific
   API token.
3. Go to **Settings → Prolific completion and exit paths**.
4. Paste the six complete HTTPS redirect URLs into:
   - Full completion
   - Consent declined
   - Ineligible
   - Voluntary withdrawal
   - Group not formed
   - Technical/group failure
5. Click **Save** (enabled once a field has changed).
6. Reload the page and verify every value remains present.

Each URL must parse and use `https:` (plain `http:` is accepted only for
localhost); otherwise `PUT /api/settings` answers 400 and nothing is saved.
These settings are persisted in the research database. There is no environment
fallback for early-exit paths. The build-time `VITE_PAYMENT_URL` fallback is
not a substitute for configuring the production Prolific paths.

## 6. Configure the server lifecycle and payments

Use `infra/.env.example` as the reference. Production values live only in
`infra/.env` on the server.

| Variable | Meaning | Current value |
| --- | --- | --- |
| `PROLIFIC_STUDY_ID` | Only this study may claim a Prolific seat (the check is skipped when empty) | `6a69fc8742750ae81af3d24a` |
| `PROLIFIC_API_TOKEN` | Server-only full-permission researcher credential. Its presence is what switches API-backed validation on | configured secret |
| `PROLIFIC_REQUIRE_VALIDATION` | Production boot check only: with `GDM_ENV=production` the Session Manager refuses to start unless study ID and API token are configured. It does not itself enable or disable validation | `true` |
| `WAITING_TIMEOUT_MINUTES` | Deadline from creation of the forming lobby (floored at 1) | `5` |
| `PARTICIPANT_RECONNECT_GRACE_SECONDS` | Missing-heartbeat grace before terminal disconnect (floored at 5) | `30` |
| `PARTIAL_PAYMENT_PENCE_PER_MINUTE` | Partial amount per started elapsed minute; minimum enforced by code is 10p | `10` |
| `PARTIAL_PAYMENT_MAX_PENCE` | Maximum queued partial amount (floored at 10p) | `508` |
| `PROLIFIC_AUTO_RETURN_DISCONNECTS` | Call Prolific's request-return API after connection timeout; a failed call is stored as `failed` with a retry in 5 minutes (retried only if automation is on) | `true` |
| `PROLIFIC_PAYMENT_AUTOMATION` | Every 30 seconds process up to 20 due rows (compensation status `pending` or `failed`, fewer than 5 attempts, retry time reached) | `false` |

Keep `PROLIFIC_PAYMENT_AUTOMATION=false` unless automatic payment has been
explicitly approved and tested. With it off, compensation actions remain in
the admin queue. **With it on, the loop requests a return for every
non-`completed` outcome that has none yet — including `ineligible` and
`declined_consent` rows — and then prepares and pays the bonus for `partial`
rows.** That conflicts with the screened-out design above (Prolific's
screen-out path is meant to approve and pay the screen-out reward), which is
a further reason to keep automation off. `PROLIFIC_AUTO_RETURN_DISCONNECTS=true`
is narrower: it only requests a return for the specific connection-timeout
path and never pays a bonus.

Production refuses to start with validation required but no study ID/API
token, and also when `PROLIFIC_PAYMENT_AUTOMATION=true` without an API token.
If Prolific's API is unavailable, API-backed admission fails closed with a
temporary validation error rather than admitting an unverified submission.

## 7. Participant identity and admission security

### Browser behavior

- All three identifiers must be present.
- The browser stores the identity in `sessionStorage` (key
  `gdm-prolific-identity`; the tracking token under `gdm-tracking-token`) for
  same-tab refresh and removes the identifiers from the address bar with
  `history.replaceState`.
- The internal tracking token (`prolific:<STUDY_ID>:<SESSION_ID>`) contains
  the study and submission IDs but not the participant PID.
- Closing the tab clears the browser's Prolific identity; reopening the
  original Prolific link re-establishes and resumes it from the server record.

### Server validation

With current production settings (API token configured) the server:

1. requires 24-character alphanumeric PID, study ID, and submission ID
   (`/^[a-z0-9]{24}$/i`; without an API token a 12–23-character preview-style
   submission ID is also accepted);
2. requires `STUDY_ID` to equal `PROLIFIC_STUDY_ID` (when set);
3. rejects a second PID for an already recorded `(STUDY_ID, SESSION_ID)`;
4. calls `GET https://api.prolific.com/api/v1/submissions/{SESSION_ID}/`;
5. requires the returned submission ID, study ID, and participant ID to match;
6. accepts active/resumable statuses (`RESERVED`, `ACTIVE`,
   `AWAITING_REVIEW`, and `APPROVED`; a missing status also passes). The
   terminal statuses `RETURNED`, `TIMED_OUT`, `SCREENED_OUT` and `REJECTED`
   are accepted only by the resume path and the outcome poll, so a returned
   participant can still see their stored exit state;
7. caches a successful match for 60 seconds (keyed by study, submission and
   PID; at most 5 000 entries); and
8. enforces a unique `(STUDY_ID, SESSION_ID)` database record on both the
   arrival and the participant table.

The Prolific request timeout is five seconds for submission checks (eight
seconds for the admin/automation calls). A 404 is treated as an unknown
submission; invalid identifiers, a wrong study, an identity mismatch, or a
non-accepted status answer HTTP 400; a PID that conflicts with a stored
arrival or seat answers HTTP 409; other API failures return a temporary
service-unavailable (503) response.

## 8. Lifecycle, reconnects, and matching

The durable stages are:

```text
arrived → consent → entry → waiting → chat → exit → done
                                            ↘ terminated
```

- The frontend sends a heartbeat/progress update immediately on a relevant
  stage change, whenever the tab becomes visible again, and every 10 seconds
  while active.
  The heartbeat reports `consent` for the whole entry flow, then `waiting`,
  `chat` and `exit`; `entry` is sent once when the entry survey is completed,
  and nothing is sent on `done`. Stages only advance forward; a later
  heartbeat cannot regress the stored stage, and any outcome freezes it. The
  heartbeat also polls the stored outcome and switches to the exit page if a
  terminal outcome other than `completed` exists.
- The backend checks expired lobbies and stale participants every 5 seconds
  (stale participants: up to 100 per sweep, only in stages `arrived` … `exit`;
  direct participants are never swept). Expired lobbies are additionally
  aborted synchronously whenever a seat is reserved.
- The waiting deadline starts when the forming session is created, which is
  effectively when its first participant joins after completing the entry
  flow. Time spent completing the entry survey does not consume the five-minute
  waiting-room deadline.
- A refresh/reconnect within 30 seconds resumes the existing stage and seat.
- After 30 seconds without a heartbeat, `connection_timeout` becomes terminal.
- In a waiting lobby, the stale seat is removed. In a provisioning/running
  group, the group is aborted, the other Prolific members are terminated with
  `participant_dropout`, and all Matrix members are removed so the remaining
  participants are not stranded in an invalid task. A voluntary withdrawal
  from a provisioning/running group aborts the group in the same way (without
  the Matrix kick).
- The same submission cannot join another group after receiving a terminal
  outcome. Reopening the link shows the stored exit/debrief state.
- A full group provisions the Matrix room in the background and starts the live
  task. Repeated join calls are idempotent and return the existing seat.

Direct participants use the normal lobby and study flow but do not create a
Prolific arrival/outcome, do not receive Prolific return links, and are clearly
marked `direct` in exports.

## 9. Outcomes and compensation rules

| App outcome | Typical cause | Compensation recorded by app | Redirect field |
| --- | --- | --- | --- |
| `completed` | Exit survey persisted and participant marked complete | `full`; normal base reward handled by Prolific path/review | Full completion |
| `declined_consent` | Consent not granted | `none` | Consent declined |
| `ineligible` | Under 18 or English proficiency `None` | `none` in the app; Prolific screen-out path pays its configured reward | Ineligible |
| `voluntary_withdrawal` | Participant chooses to stop (from a live group this also aborts the group) | `none` before entry; `manual_review` from entry/wait/chat/exit | Voluntary withdrawal |
| `connection_timeout` | No heartbeat beyond 30-second grace | `none` at arrival/consent; `manual_review` at entry; time-based `partial` at waiting/chat/exit | Technical/group failure, falling back to Voluntary withdrawal |
| `unmatched` | Group not full after five minutes | time-based `partial` | Group not formed |
| `technical_failure` | Lobby still provisioning its room when the waiting deadline passed | time-based `partial` | Technical/group failure, falling back to Group not formed |
| `participant_dropout` | Another participant leaves/disconnects during group | time-based `partial` for affected Prolific group members | Technical/group failure, falling back to Group not formed |
| `group_aborted` | A new study round was started while the participant was in a waiting lobby | time-based `partial` | Technical/group failure, falling back to Group not formed |

Time-based partial compensation is calculated from the persisted arrival time
(falling back to the session's creation time when no arrival row exists;
elapsed time is floored at one second):

```text
amount = min(maximum, max(10p, ceil(elapsed_seconds / 60) × pence_per_minute))
```

At the current 10p/minute rate and 508p cap, 1–60 seconds records £0.10,
61–120 seconds records £0.20, and no partial outcome exceeds £5.08. The amount
is a queued bonus, not an automatic approval or immediate payment.

Post-consent early exits show the withheld-purpose debrief and require
acknowledgement before the return link becomes active. Consent declines and
eligibility screen-outs do not show that debrief.

## 10. Admin compensation workflow

Open **Admin dashboard → Prolific** (section "Prolific outcomes and
compensation"). Each row shows the submission ID (first 8 characters; the full
id in the tooltip), stage/outcome with reason, elapsed time, compensation
decision/amount, Prolific action state with any error, and the action buttons.
Actions are only offered for rows whose outcome is not `completed`.

Available actions (all `POST /api/admin/prolific/outcomes/:id/actions/<action>`):

- **Request return** (`request-return`, confirmation dialog) calls Prolific's
  `POST /submissions/{SESSION_ID}/request-return/`.
- **Prepare bonus** (`prepare-bonus`) requests a return if the app has not
  recorded one, then creates a Prolific bulk-bonus batch
  (`POST /submissions/bonus-payments/`) for the exact queued amount.
- **Pay bonus** (`pay-bonus`, confirmation dialog) submits the prepared batch
  (`POST /bulk-bonus-payments/{batchId}/pay/`). The button only appears, and
  the server only accepts it, while the row is in state `bonus_prepared`.
- **Resolve manually** (`resolve-manually`) records that the researcher
  reconciled the case outside the automated workflow.

Prolific action states: `not_required` (full completion), `pending`,
`return_requested`, `bonus_prepared`, `payment_in_progress`,
`payment_uncertain`, `payment_submitted`, `resolved_manually`, and `failed`
(carries the error and a retry time 5 minutes later; automation retries up to
5 attempts).

Recommended manual process while `PROLIFIC_PAYMENT_AUTOMATION=false`:

1. Compare the app outcome with the submission in Prolific.
2. Confirm whether the participant already followed the completion path.
3. For `full`, review the research data and approve the base submission in
   Prolific according to the protocol.
4. For `none`, ensure the correct return or screened-out state is present.
5. For `manual_review`, decide and document any discretionary payment.
6. For `partial`, confirm the calculated amount, request/confirm return,
   prepare the bonus, verify the batch, and only then click **Pay bonus**.
7. Reconcile the resulting Prolific submission/bonus state and mark manually
   resolved where appropriate.

Prolific's bulk-bonus payment endpoint is not idempotent: submitting the same
batch twice can pay twice. The app persists a one-way `payment_in_progress`
guard before calling it. A timeout, crash, non-success response, or failure to
persist the success marker becomes `payment_uncertain`; never retry such a row
until the batch has been checked directly in Prolific.

## 11. Data and reconciliation

The application persists arrivals separately from session participants, so a
person who leaves before the waiting room is still visible.

Admin/API sources:

| Source | Purpose |
| --- | --- |
| Admin **Prolific** tab | Live outcome and compensation queue |
| `GET /api/export/prolific-arrivals` | JSON array of every validated arrival (raw PID, study and submission ids, stage, outcome, compensation), including pre-seat exits; no filters |
| `GET /api/export/prolific-outcomes` | JSON `{ outcomes }` with the same data plus return/bonus/payment fields; no filters |
| `GET /api/export/linkage.csv` | Pseudonym → internal UUIDs, `tracking_token` (`prolific:<STUDY_ID>:<SESSION_ID>`), `recruitment_source`, Matrix id. It does **not** contain the PID |
| `participants.csv`, `surveys` exports, full JSON dump | Carry `recruitment_source`; the surveys exports and the full JSON dump also carry the three raw Prolific ids |
| `research_data.zip` (Overview tab) | Its `results.csv` has a raw `prolific_id` column — identifying |

The pseudonymized research bundle (`research.zip`) deliberately excludes
`linkage.csv` and does not expose Prolific IDs. Store the linkage export,
the surveys exports, the full JSON dump and the Overview-tab research-data zip
with appropriately restricted access and follow the approved
retention/deletion plan.

Reconcile using `SESSION_ID` first because it identifies the Prolific
submission. `PROLIFIC_PID` identifies the participant and `STUDY_ID` identifies
the study. Do not rely only on browser completion codes; compare Prolific's
submission state with the app's durable outcome and data completion.

## 12. Preview and test procedure

### Important Prolific preview limitation

Prolific preview links may use synthetic participant/submission identifiers
that do not represent a retrievable live submission. Production currently has
API-backed verification enabled and requires a real 24-character submission
that Prolific's API returns. A preview link can therefore be rejected even when
the production integration is correct.

Use preview to inspect the study listing and resulting URL shape. For an
end-to-end admission/completion test, run a small real pilot submission in the
draft/pilot study, or test in a non-production environment with validation
disabled (`PROLIFIC_API_TOKEN` empty — only then are the shorter preview
submission ids accepted). Do not disable production validation while a study
is open.

### Minimum live pilot

1. Save the study as a draft and configure all URLs/codes.
2. Fund enough places and screen-out budget.
3. Confirm the app's active condition and group size in Admin → Settings.
4. Release exactly one group (currently three participants).
5. Watch Admin → Prolific and Overview without changing settings mid-session.
6. Verify all three arrivals pass through waiting, chat, exit, and `completed`.
7. Confirm each browser reaches the default completion URL and each Prolific
   submission shows `AWAITING_REVIEW` under the current manual-review setting.
8. Verify the exit surveys and research bundle before approving submissions.
9. Separately test consent decline, screen-out, voluntary withdrawal,
   unmatched waiting, and disconnect on a controlled pilot where the costs and
   participant communication are understood.

### Safe health checks

```bash
ssh masterproject 'cd ~/gdm-platform/infra && docker compose ps'

ssh masterproject \
  'cd ~/gdm-platform/infra && docker compose logs --since=10m session-manager \
    | grep -E "Prolific|openSession|completed|terminated|P2024|ERROR"'
# (P2024 is Prisma's connection-pool timeout code, not an application log line)

curl -fsS https://gdmproject.ifi.uzh.ch/api/health/ready
```

Do not print `infra/.env`, `PROLIFIC_API_TOKEN`, `ADMIN_API_TOKEN`, Matrix
access tokens, or raw linkage data into a shared terminal transcript.

## 13. Launch checklist

### Prolific

- [ ] Correct researcher workspace and funded balance
- [ ] External study link points to the production HTTPS domain
- [ ] URL parameter recording enabled with all three standard names
- [ ] Secure external URL/JWT remains off until implemented in the app
- [ ] Desktop-only requirement selected
- [ ] Participant target/release plan matches group size
- [ ] Simultaneous access limit chosen deliberately
- [ ] Audience/prescreeners reviewed and documented
- [ ] Duration and reward reflect current pilot median and policy
- [ ] Custom screen-out enabled with enough slots and correct reward
- [ ] Six completion paths exist and processing rules are correct
- [ ] Default completion remains manual review unless auto-approval is intended
- [ ] Repeat participation and fast-rejection settings reviewed

### Server and app

- [ ] `PROLIFIC_STUDY_ID` matches this exact Prolific study
- [ ] `PROLIFIC_API_TOKEN` is configured server-side and not exposed
- [ ] `PROLIFIC_REQUIRE_VALIDATION=true`
- [ ] Waiting, reconnect, partial rate, and cap match the approved protocol
- [ ] `PROLIFIC_AUTO_RETURN_DISCONNECTS` reviewed
- [ ] `PROLIFIC_PAYMENT_AUTOMATION=false` for researcher-reviewed operation
- [ ] All six admin completion/exit URLs saved and reloaded successfully
- [ ] Active condition(s), goals, round, group size, and chat duration verified
- [ ] Participant, admin, Matrix, and readiness endpoints healthy
- [ ] No active old lobbies from a prior round
- [ ] One complete live pilot and each abort path reconciled

### After collection

- [ ] Completed app records matched to Prolific submissions by `SESSION_ID`
- [ ] Exit surveys and participant completion checked before approval
- [ ] Returns/screen-outs checked against app outcomes
- [ ] Partial/manual-review cases resolved and documented
- [ ] `payment_uncertain` rows checked in Prolific before any further action
- [ ] Research bundle and restricted linkage export backed up
- [ ] Unused Prolific places/funds handled according to the study plan

## 14. Troubleshooting

| Symptom | Likely cause / check |
| --- | --- |
| "This Prolific study link is incomplete" | One or two standard parameters are missing or renamed. Confirm all three uppercase names in the final URL. |
| "We could not validate your Prolific study link. Please return to Prolific and try again." | Shown for any failure while entering the study (validation, 409 conflicts, network errors, 503). Check `STUDY_ID`, real submission status, API token, Prolific API availability, and Session Manager logs. Preview synthetic IDs are not accepted in production. |
| `openSession failed: 400` (Waiting Room error) | 400 covers invalid identifiers, an unexpected study, an unknown submission, an identity mismatch, a non-accepted Prolific status, or request-shape validation. Full/inactive conditions, an already-ended participation, a PID conflict, and an aborted waiting attempt answer 409 instead. |
| Direct visitors cannot enter | No-parameter links should work. Check active conditions/goals and general service health rather than Prolific settings. |
| Participant gets a second lobby/seat | The same Prolific submission should be idempotent. Check whether a different `SESSION_ID` or a direct link was used. |
| Participant cannot rejoin after 30 seconds | The outcome is intentionally terminal after reconnect grace. Reopening shows the recorded exit path, not a new group. |
| Return button disabled | The participant must acknowledge the debrief, except for no-consent/screen-out paths on the exit page. On the full-completion page acknowledgement is always required (direct participants too). |
| "The return link is not configured. Please keep this page open and contact the researcher through Prolific." (exit page) / "The Prolific completion link has not been configured yet…" (completion page) | The matching URL is empty in Admin → Settings. Record is safe; add the correct path and reconcile manually. |
| Submission returned but admin still offers Request return | The participant probably followed the Prolific completion path; the app cannot observe that click. Verify in Prolific, then resolve manually. |
| Bonus is `payment_uncertain` | Check the exact batch/payment in Prolific. Do not click/pay again until reconciled. |
| Group does not form | Confirm active condition capacity, release sizes, participant dropouts, and five-minute deadline. Process unmatched partial bonuses. |
| Admin says "Could not load conditions" | This is an admin/backend health or authentication issue, not evidence that participant identity validation failed. Check container health and logs. |

## Official Prolific references

- [External software, URL parameters, and returning participants](https://researcher-help.prolific.com/en/articles/445178-what-survey-experimental-software-is-compatible-with-prolific)
- [Data collection, custom screening, and completion paths](https://researcher-help.prolific.com/en/articles/445127-data-collection)
- [Prolific IDs and secure external URLs](https://researcher-help.prolific.com/en/articles/445133-what-are-prolific-ids-and-how-do-i-use-them)
- [Previewing a study](https://researcher-help.prolific.com/en/articles/445131-previewing-your-study)
- [In-study screening guidance](https://researcher-help.prolific.com/en/articles/445165-can-i-screen-participants-within-my-study)
- [Retrieve a submission API](https://docs.prolific.com/api-reference/submissions/get-submission)
- [Request a submission return API](https://docs.prolific.com/api-reference/submissions/request-submission-return)
- [Set up bonus payments API](https://docs.prolific.com/api-reference/bonuses/create-bonus-payments)
- [Pay bonus API and non-idempotency warning](https://docs.prolific.com/api-reference/bonuses/pay-bonus-payments)
