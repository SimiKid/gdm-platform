# Bot Rulebook

How the intervention bot works, from trigger to message delivery.

## Research Context

The study uses a **between-subjects design with one factor, delivery** —
public vs. private nudges — plus a **no-intervention baseline** to test
whether real-time AI nudges during group discussions improve decision quality
and group experience.

Delivery is carried by `interventionMode` (`public` / `private` / `baseline`).
Both nudging arms use the same rule + LLM detection (`llmMode: "active"`:
composite dominance score), so detection/trigger logic is identical across
delivery conditions — only public vs. private delivery differs, preserving
internal validity. The baseline runs with `llmMode: "off"` (raw contribution
share, no classifier calls) because it never delivers anything. Every nudge
uses the same wording policy: fresh, friendly, encouraging text that names
only the target and their exact percentage.

## Experimental Conditions

| Condition | Delivery (`interventionMode`) | Detection (`llmMode`) | Description |
|---|---|---|---|
| `baseline` | baseline | off | No bot intervention; messages are recorded but the bot stays silent |
| `public-llm` | public | active | Public nudges, rule + LLM meaningfulness detection |
| `private-llm` | private | active | Private nudges, rule + LLM meaningfulness detection |

The nudge **format and tone constraints are identical across all non-baseline
conditions**; only the delivery (public vs. private) differs. The exact wording
is generated afresh for each intervention. (An earlier neutral/engaging tone
axis was retired; conditions persisted with old mode strings like
`public-engaging` are folded onto the delivery axis automatically.)

Each condition is assigned to a session at creation time and cannot change mid-session. Three conditions are seeded on first startup.

## Intervention Lifecycle

The bot evaluates **at the end of every contribution window**, not on
individual messages: once the warm-up ends, a window closes every
`contributionWindowMinutes` and the just-finished window is scored. At most
one nudge is sent per window.

```
Window boundary reached (every contributionWindowMinutes)
        |
        v
  Is it inside the intervention window?
  (after protectedStart, before protectedEnd)
        |  no -> stop (logged warm-up / wrap-up)
        v
  Are at least 2 participants in the room?
        |  no -> stop (logged too-few-participants)
        v
  Compute contribution split over the closed window
  (messages after the last tracker reset only)
        |
        v
  Any participant's dominance score >= threshold?
        |  no -> stop (logged no-target)
        v
  Drop candidates in an invite grace period
        |  none left -> stop (logged grace-suppressed)
        v
  Is mode "baseline"? ── yes ──> stop (logged baseline-suppressed)
        |  no
        v
  Build and send intervention message to the top target
        |
        v
  Reset contribution tracker; log intervention
```

### Entry Points

The session service (`backend/chat-service/src/sessions/sessions.service.ts`) records every timeline event into the `SessionRuntime` first and skips events already processed before a restart. Messages from service users (the bot itself and the orchestrator) are recorded too (with `recipientId` for private ones) but never reach the rules, the classifier or moderation. For participant events it then calls `ContributionBotRules.onEvent()` in `backend/chat-service/src/rules/bot-rules.ts`. `onEvent()` only observes: it returns immediately for anything but an `m.room.message`, and for messages it triggers the LLM classification in the nudging arms (`llmMode: "active"`) and is a no-op in the baseline. `ContributionBotRules.onWindowElapsed()` is called by the session service's per-session window timer at each boundary (aligned to the end of the warm-up, so restarts resume the same window grid) and decides the nudges. The wiring goes through a thin `StudyBotRules` wrapper (`app.module.ts`) that, before evaluating, waits up to 2 seconds (`CLASSIFICATION_WAIT_MS`) for classifications still in flight for the closed window, so slow LLM responses are usually included rather than counted as 0.

The participant list used for the contribution split is fetched from Matrix (`joined_members`) once, triggered by the first participant message handled in a nudging arm or by the first window boundary, and cached for the whole session. If the lookup fails, the cached promise is dropped (the next call retries Matrix) and the engine falls back to the distinct message senders seen so far. A participant who joins after a successful snapshot does not appear in the split.

When the session ends, the window timer is cleared and any evaluation still in flight is awaited before the session is finalized.

### Gate 1: Warm-up and Protected End

- **Warm-up** (`protectedStartMinutes`, default 3): while participants
  arrive, nothing is counted and no interventions fire. The window grid
  starts when the warm-up ends — the first evaluation happens one window
  length later, and warm-up messages are excluded from every window's
  contribution split. (They are still recorded, and classified for
  analysis, like all messages.)
- **Protected end** (`protectedEndMinutes`, default 2): no interventions in the last N minutes before the timer expires.

This gives participants unmonitored time to settle in and wrap up.

### Gate 2: Contribution Score

Over the just-closed window (`contributionWindowMinutes`, default 4 minutes), the bot calculates each participant's contribution:

```
score = messageCount * scoreWeights.messages + wordCount * scoreWeights.words
share = score / totalScore
```

With default weights (`messages: 1`, `words: 0.05`), a message counts as 1 point plus 0.05 per word. A 20-word message = 1 + 1 = 2 points.

Only messages within the closed window **and after the last tracker reset**
are counted (see Gate 4): a message counts when its timestamp is strictly
after the reset point and not after the window boundary (a message whose
timestamp cannot be parsed is counted unconditionally). Older messages fall
off, so the score reflects recent activity, not cumulative history. Emoji
reactions never count — the intervention is about turn-taking in
talking/typing, and the chat UI no longer offers reactions at all (removed
per study protocol for a cleaner design).

The trigger metric is the **dominance score**:

- Baseline (`llmMode: "off"`): `dominance = share`.
- Nudging arms (`llmMode: "active"`):
  `dominance = 0.90 × share + 0.10 × meaningfulness`, where meaningfulness is
  the mean `meaningfulnessScore` of the member's classified messages in the
  window (0 when none are classified, e.g. on API failure). Weights are
  configurable via `dominanceWeights`.

### Gate 3: Threshold and Grace Period

If any participant's `dominance score >= contributionThreshold` (default
0.40), they become a candidate target. Candidates are sorted by dominance
score descending (ties broken by raw score descending) and **only the top
one** is nudged per trigger.

A candidate is skipped while their **invite grace period** runs: when their
classified message shows `invitesParticipation == true` (nudging arms
only), they cannot be flagged for `inviteGraceSeconds` (default 60) — a
reward for self-correction. The grace window starts at the Matrix timestamp
of the inviting message (not at the moment the classification returns);
when classifications resolve out of order, only the newest invitation is
kept; and a grace period that starts after a window's boundary does not
protect that already-closed window.

If nobody crosses the threshold, no intervention fires. Gate order matters
for the audit log: over-threshold candidates are computed first, then grace
filtering, then the baseline check — so a baseline window whose only
candidates are all in grace is logged `grace-suppressed`, not
`baseline-suppressed`.

### Gate 4: Tracker Reset

Sending a nudge stamps the reset point at the **closed window's boundary**
(not the send moment, which can be up to ~2 s later due to the
classification wait): all messages up to and including that boundary are
wiped from future dominance calculations, so the tracker restarts
at parity ("back to 20-20-20-20-20"). The goal is equal turns from now on,
not an equally balanced whole session — a dominant member who keeps dominating
after a reset is flagged again at the end of the next window.

## Nudge Wording

Anthropic generates fresh wording for each intervention
(`backend/chat-service/src/nudge/anthropic-nudge-message-generator.ts`; same
model as the classifier, `temperature: 0.9`, `max_tokens: 120`, 5-second
request timeout, JSON-schema output). The prompt requires a short, friendly,
encouraging nudge that positively acknowledges participation and gently asks
the target to draw in other voices; it also lists the last 8 nudges of the
session so the model avoids repeating them. Every result must name **only the
target and their own exact percentage**; the other members' names and shares
are never revealed to participants (they remain in the audit log for
analysis).

Server-side validation rejects wording that mentions the target other than
exactly once (`@Name`), contains any other `@mention`, names another
participant (case-insensitive, whole-word), contains any percentage other
than exactly one occurrence of the target's, exceeds 45 words or 320
characters, or exactly repeats (after whitespace normalization) **any**
earlier nudge of the session. The generator retries once, asking for a
substantially different version. If `ANTHROPIC_API_KEY` is missing, the API
is unavailable, or both results fail validation, the bot rotates through five
friendly fixed fallback texts (selected by the number of interventions so far
modulo 5) so a valid intervention is never lost.

The percentage is the target's **raw contribution share** (airtime), not the
composite dominance score. The generated text actually sent is retained in the
intervention audit log.

## Private Message Delivery

Private nudges are sent to the same Matrix room as regular messages, but with an extra content field (`de.gdm.recipient`) set to the target's Matrix user ID. The participant frontend filters messages: if a message has a `de.gdm.recipient` field, only the matching participant sees it. For public modes, no recipient field is set.

Every bot message carries a prominent Zoom-style delivery badge so
participants are never unsure who can see a nudge:

- Private: **🔒 Private message to you (only you can see this)**
- Public: **📢 Message to ALL in the group**

In private mode, the single selected target gets the private message; exactly
one nudge is sent per trigger in both delivery modes.

The same private-delivery mechanism is reused by the optional chat moderation
feature (see below): a moderation warning is a bot message with
`de.gdm.recipient` set, so it is rendered with the 🔒 badge to the sender
only, but it is **not** an intervention and produces no `InterventionLog`.

## Chat Moderation (optional, off by default)

Independent of the study arm, the chat service can moderate participant
messages when the environment variable `MODERATION=on` is set
(`backend/chat-service/src/classifier/moderation-classifier.ts`). Every
participant `m.room.message` is then sent to Anthropic (same model as the
classifier, `temperature: 0`, 5-second timeout) with a system prompt asking
whether it contains hate speech, slurs, severe insults, threats, or other
abusive language; normal disagreement and informal language must not be
flagged. A flagged message is redacted in the Matrix room (reason
`moderation`) and the sender receives the private bot message *"Your message
was removed because it violates the study's conduct policy. Please keep the
discussion respectful."* Moderation fails open: API errors, a missing
`ANTHROPIC_API_KEY`, or any value other than `on` leave messages untouched.
Note that the runtime only processes redactions of *reactions*: a
moderation-redacted message stays in the recorded chat log and still counts
toward the contribution split. The default in `infra/.env.example` and in
Docker Compose is `off`.

## Participant Identities

Participants are not addressed by their real names or Matrix user IDs in bot messages. Instead, the system assigns **color identities** (e.g., "Red", "Blue", "Green" — a 10-color palette) based on a deterministic mapping from sorted participant user IDs. This is defined in `packages/shared/src/identity.ts`.

## Quiet Members (audit only)

Each intervention log records the **quietest members** — up to 2 participants with the lowest contribution share whose dominance score is below the threshold and who are not the target. They are **never named in the participant-facing nudge** anymore; the field exists purely for analysis.

## Configurable Parameters

All parameters are stored in the condition's `config` object (plus the
session-level `durationMinutes`, `groupSize`, and recruiting `goal` on the
condition itself). The admin dashboard (Settings → Session & Bot Parameters)
edits **six of them as one shared form applied to all study arms** —
duration, group size, warm-up (minutes), protected end (entered in seconds),
window length (entered in seconds), and threshold (entered in %) — and shows
a drift warning when an arm deviates from the shared values. A separate
Settings → Shared Workspace card applies `workspaceMode` to all arms in the
same way. The delivery mode (`interventionMode`) is displayed as a read-only
badge per arm. The remaining fields (`llmMode`, score/dominance weights,
invite grace) are fixed study design: they are not shown in the dashboard at
all and can only be changed via `PUT /api/conditions/:id`. Protected end and
window length may be fractional minutes (e.g. `1.5` = 90 seconds); the
protected end also drives the participant timer's red "wrap up!" cue.

The session manager clamps admin input on save: `contributionThreshold` to
0.01–1, `contributionWindowMinutes` to 0.1–240, `protectedStartMinutes` to
0–240, `durationMinutes` to 1–240, `groupSize` to 2–50 and `goal` to
0–100000. `protectedEndMinutes`, `inviteGraceSeconds` and `llmMode` are not
validated beyond being well-formed JSON. An unrecognized `llmMode` value is
inconsistent: the classifier still runs (the gate only checks for `off`),
but the dominance formula falls back to the raw share (it only checks for
`active`) — so keep it to exactly `off` or `active`.

| Parameter | Field | Default | Description |
|---|---|---|---|
| Delivery mode | `interventionMode` | `public` | `baseline` / `public` / `private` |
| Shared workspace | `workspaceMode` | `ranking` | `ranking` (shared Moon Survival ranking beside the chat) or `external` (dormant iframe extension point, renders a not-configured placeholder); optional `externalWorkspace` holds a future provider URL/title and is not editable |
| Threshold | `contributionThreshold` | `0.40` | Dominance score at which a participant triggers an intervention |
| Warm-up | `protectedStartMinutes` | `3` | Arrival phase: nobody is counted or nudged; the first window starts when it ends |
| Protected end | `protectedEndMinutes` | `2` | Minutes of no-intervention cool-down |
| Invite grace | `inviteGraceSeconds` | `60` | Flag suppression after a member invites others (nudging arms) |
| Score window | `contributionWindowMinutes` | `4` | Window length; the bot evaluates (and can nudge once) at the end of every window |
| Message weight | `scoreWeights.messages` | `1` | Points per message |
| Word weight | `scoreWeights.words` | `0.05` | Points per word |
| Share weight | `dominanceWeights.share` | `0.90` | Composite weight of the raw contribution share |
| Meaningfulness weight | `dominanceWeights.meaningfulness` | `0.10` | Composite weight of the LLM meaningfulness score |
| Classifier mode | `llmMode` | `off` | `active` in both nudging arms (composite score + grace period); `off` (raw share, no classifier) in the baseline. Not a study axis |

Defaults are defined in `packages/shared/src/interventions.ts` (`DEFAULT_INTERVENTION_CONFIG`). Conditions are seeded with these defaults by the session manager on first startup (see `seedConditions()` in `backend/session-manager/src/store/store.service.ts`), along with session-level defaults `goal: 5`, `durationMinutes: 10`, `groupSize: 3`.

Changes to a condition in the admin dashboard affect **future sessions only**. Running sessions use the condition snapshot captured at creation time. To run different parameters for a distinct phase of data collection, start a new **study round** (Settings → Study Rounds): sessions are stamped with the round they were created in, so exports can separate the phases (see `docs/data-export.md`).

## Audit and Export

Every intervention is recorded as an `InterventionLog` (type in
`packages/shared/src/interventions.ts`) containing:

- Session, room, and condition IDs
- Delivery mode, audience, and detection mode (`llmMode`)
- Timestamp
- Trigger (`contribution-threshold`), the threshold, and the window length
  in effect
- The full contribution split at the time of intervention
- Target(s) and quiet member(s) identified
- The exact message text sent

In addition, the bot records a **`WindowEvaluation` for every window boundary it reaches** — fired or not. Each carries the window's grid index (0-based, computed from the distance to the warm-up end) and time span, the window length and threshold in effect, the detection mode (`llmMode`), the outcome (`nudged`, `no-target`, `grace-suppressed`, `baseline-suppressed`, `warm-up`, `wrap-up`, `too-few-participants`), the full contribution split, the over-threshold candidates *before* grace filtering and the highest dominance score where a split was computed, and a link to the `InterventionLog` when a nudge fired. Baseline sessions therefore carry per-window dominance data comparable to the delivery arms (`baseline-suppressed` marks windows where a nudge *would* have fired) — with the caveat that in the baseline `dominanceScore` equals the raw share and `meaningfulnessScore` is always 0, because the classifier is not called. Failed LLM classification requests are recorded as `ClassificationFailure` entries, so classifier coverage is auditable. Both records are persisted in the research database with their full JSON payload. The bot's own nudge messages are stored in the chat log (with `recipientId` set on private nudges) but never count toward contribution scores.

These records are included in the raw exports (`/api/export/sessions`, `/api/export/interventions`), power the dashboard's **Results** tab, and feed the analysis-ready research exports (`/api/export/windows`, `/api/export/research.zip`) — see `docs/data-export.md`.

## Meaningfulness Classifier (Rule + LLM Detection)

Conditions with `llmMode: "active"` (both nudging arms) classify every
participant message with Anthropic's Messages API
(`backend/chat-service/src/classifier/anthropic-contribution-classifier.ts`).
The same API also generates fresh nudge wording in every non-baseline arm (see
Nudge Wording); `ANTHROPIC_API_KEY` must be set for dynamic wording and
Rule+LLM detection. The default model is `claude-haiku-4-5-20251001`
(override via `ANTHROPIC_MODEL`). The classifier calls it with
`temperature: 0`, `max_tokens: 500`, a 10-second request timeout and strict
JSON-schema output. `LLM_MODE` (exactly `off` or `active`; any other value is
ignored) is an optional global override of every condition's `llmMode`. A
message is classified at most once; a failed call is stored as a
`ClassificationFailure` with the error text (truncated to 500 characters).
Without an API key in a nudging arm, every message is recorded as a
`missing-api-key` failure, meaningfulness is 0 for everyone (so `dominance =
0.9 × share`), the invite grace period can never activate, and nudges use
the fixed fallback wording; in production the chat service refuses to start
without the key. Per message, the classifier judges four structural
indicators (each `true`/`false` plus a one-sentence reason), following the
study protocol:

- `respondsToPrior` — addresses, reacts to, builds on, or directly refers to a
  specific prior message or group member;
- `referencesTaskItem` — explicitly names one or more ranking-task items;
- `hasDiscussionStructure` — explicit stance, proposal, or structured
  discourse move (agree/disagree, "X at position Y", counterproposal);
- `invitesParticipation` — explicitly invites another (named or unnamed)
  member to contribute. **Tracked separately** — it will feed the dominant
  contributor's self-correction grace period, never the score.

The mean of the first three indicators is stored as `meaningfulnessScore`
(0..1). It feeds the composite dominance score (`0.90 × contribution share +
0.10 × meaningfulness`, see Gate 3) and `invitesParticipation` drives the
invite grace period. Each classification also records the model ID, prompt
version (`meaningfulness-v1`), the exact prompt, and the raw JSON output for
auditability.

The prompt contains the message, the sender's pseudonym, the immediately
preceding 3 messages, the ranking-task item list, and the group member list
with the member count.
Classifications and participant aggregates (per-indicator counts and the mean
meaningfulness score) are available from `/api/export/contributions` and
`/api/export/contributions.csv`.

The API receives pseudonymous color labels,
but it does receive chat text; consent and the data-processing documentation
must state this before the nudging arms are used with real participants.

## Key Source Files

| File | What it does |
|---|---|
| `packages/shared/src/interventions.ts` | Type definitions, defaults, audience/legacy-mode helpers |
| `packages/shared/src/identity.ts` | Color identity assignment |
| `backend/chat-service/src/rules/bot-rules.ts` | The rule engine (`ContributionBotRules`) |
| `backend/chat-service/src/nudge/anthropic-nudge-message-generator.ts` | Fresh nudge wording and output validation |
| `backend/chat-service/src/classifier/anthropic-contribution-classifier.ts` | Meaningfulness classifier (prompt, schema, failure records) |
| `backend/chat-service/src/classifier/moderation-classifier.ts` | Optional abusive-content moderation (`MODERATION=on`) |
| `backend/chat-service/src/sessions/sessions.service.ts` | Event recording, window timer, checkpoints, moderation hook, finalize |
| `backend/chat-service/src/sessions/session-runtime.ts` | Per-session state, message recording, `post()` / `postPrivate()` |
| `backend/chat-service/src/matrix/matrix-bot.service.ts` | Matrix sync loop, message sending, redaction |
