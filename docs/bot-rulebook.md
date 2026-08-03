# Bot Rulebook

How the rule-based intervention bot works, from trigger to message delivery.

## Research Context

The study uses a **2x2 between-subjects design** — delivery (public/private)
× detection (rule-based / rule-based + LLM meaningfulness) — plus a
**no-intervention baseline** to test whether real-time AI nudges during group
discussions improve decision quality and group experience.

Delivery is carried by `interventionMode` (`public` / `private` / `baseline`);
detection by `llmMode` (`off` = rule-based, `active` = rule + LLM composite
dominance score). Detection/trigger logic is identical across delivery
conditions — only public vs. private delivery differs, preserving internal
validity. Every nudge uses the same wording policy: fresh, friendly,
encouraging text that names only the target and their exact percentage.

## Experimental Conditions

| Condition | Delivery (`interventionMode`) | Detection (`llmMode`) | Description |
|---|---|---|---|
| `baseline` | baseline | off | No bot intervention; messages are recorded but the bot stays silent |
| `public-rule` | public | off | Public nudges, rule-based detection |
| `public-llm` | public | active | Public nudges, rule + LLM meaningfulness detection |
| `private-rule` | private | off | Private nudges, rule-based detection |
| `private-llm` | private | active | Private nudges, rule + LLM meaningfulness detection |

The nudge **format and tone constraints are identical across all non-baseline
conditions**; only the delivery (public vs. private) differs. The exact wording
is generated afresh for each intervention. (An earlier neutral/engaging tone
axis was retired; conditions persisted with old mode strings like
`public-engaging` are folded onto the delivery axis automatically.)

Each condition is assigned to a session at creation time and cannot change mid-session. Five conditions are seeded on first startup.

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

`ContributionBotRules.onEvent()` in `backend/chat-service/src/rules/bot-rules.ts` is called for **every timeline event** in an active session's room, except the bot's own events; it only observes (records and, with an LLM arm, classifies messages). `ContributionBotRules.onWindowElapsed()` is called by the session service's per-session window timer at each boundary (aligned to the end of the warm-up, so restarts resume the same window grid) and decides the nudges. Before evaluating, the engine waits up to 2 seconds (`CLASSIFICATION_WAIT_MS`) for classifications still in flight for the closed window, so slow LLM responses are usually included rather than counted as 0.

The participant list used for the contribution split is fetched from Matrix once (at the first classified message or first window boundary) and cached for the whole session; if the lookup fails, the engine falls back to the distinct message senders seen so far. A participant who joins after that snapshot does not appear in the split.

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
are counted (see Gate 4). Older messages fall off, so the score reflects
recent activity, not cumulative history. Emoji reactions never count — the
intervention is about turn-taking in talking/typing, and the chat UI no
longer offers reactions at all (removed per study protocol for a cleaner
design).

The trigger metric is the **dominance score**:

- Rule-based arm (`llmMode: "off"`): `dominance = share`.
- Rule-based + LLM arm (`llmMode: "active"`):
  `dominance = 0.90 × share + 0.10 × meaningfulness`, where meaningfulness is
  the mean `meaningfulnessScore` of the member's classified messages in the
  window (0 when none are classified, e.g. on API failure). Weights are
  configurable via `dominanceWeights`.

### Gate 3: Threshold and Grace Period

If any participant's `dominance score >= contributionThreshold` (default
0.40), they become a candidate target. Candidates are sorted by dominance
score descending and **only the top one** is nudged per trigger.

A candidate is skipped while their **invite grace period** runs: when their
classified message shows `invitesParticipation == true` (active LLM arm
only), they cannot be flagged for `inviteGraceSeconds` (default 60) — a
reward for self-correction.

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

Anthropic generates fresh wording for each intervention. The prompt requires a
short, friendly, encouraging nudge that positively acknowledges participation
and gently asks the target to draw in other voices. Every result must name
**only the target and their own exact percentage**; the other members' names
and shares are never revealed to participants (they remain in the audit log
for analysis).

Server-side validation rejects wording that omits or repeats the target,
changes the percentage, names another participant, includes another
percentage, exceeds 45 words, or exactly repeats a recent nudge. The generator
retries once. If the API is unavailable or both results fail validation, the
bot rotates through five friendly fixed fallback texts so a valid intervention
is never lost.

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

## Participant Identities

Participants are not addressed by their real names or Matrix user IDs in bot messages. Instead, the system assigns **color identities** (e.g., "Red", "Blue", "Green" — a 10-color palette) based on a deterministic mapping from sorted participant user IDs. This is defined in `packages/shared/src/identity.ts`.

## Quiet Members (audit only)

Each intervention log records the **quietest members** — up to 2 participants with the lowest contribution share whose dominance score is below the threshold and who are not the target. They are **never named in the participant-facing nudge** anymore; the field exists purely for analysis.

## Configurable Parameters

All parameters are stored in the condition's `config` object. The admin
dashboard (Settings → Session & Bot Parameters) edits **six of them as one
shared form applied to all study arms** — duration, group size, warm-up
(minutes), protected end (entered in seconds), window length (entered in
seconds), and threshold (entered in %) — and shows a drift warning when an
arm deviates from the shared values. Everything else (`llmMode`,
`interventionMode`, score/dominance weights, invite grace) is fixed study
design: shown read-only in the UI and changeable only via
`PUT /api/conditions/:id`. Protected end and window length may be
fractional minutes (e.g. `1.5` = 90 seconds); the protected end also drives
the participant timer's red "wrap up!" cue.

| Parameter | Field | Default | Description |
|---|---|---|---|
| Delivery mode | `interventionMode` | `public` | `baseline` / `public` / `private` |
| Threshold | `contributionThreshold` | `0.40` | Dominance score at which a participant triggers an intervention |
| Warm-up | `protectedStartMinutes` | `3` | Arrival phase: nobody is counted or nudged; the first window starts when it ends |
| Protected end | `protectedEndMinutes` | `2` | Minutes of no-intervention cool-down |
| Invite grace | `inviteGraceSeconds` | `60` | Flag suppression after a member invites others (active LLM arm) |
| Score window | `contributionWindowMinutes` | `4` | Window length; the bot evaluates (and can nudge once) at the end of every window |
| Message weight | `scoreWeights.messages` | `1` | Points per message |
| Word weight | `scoreWeights.words` | `0.05` | Points per word |
| Share weight | `dominanceWeights.share` | `0.90` | Composite weight of the raw contribution share |
| Meaningfulness weight | `dominanceWeights.meaningfulness` | `0.10` | Composite weight of the LLM meaningfulness score |
| Classifier mode | `llmMode` | `off` | `off` (rule-based) / `active` (composite score + grace period) |
| Two-bot test | `comparisonMode` | unset (off) | Pilot only: both detection bots nudge side by side; optional field, only `=== true` enables it (see below) |

Defaults are defined in `packages/shared/src/interventions.ts` (`DEFAULT_INTERVENTION_CONFIG`). Conditions are seeded with these defaults by the session manager on first startup (see `seedConditions()` in `backend/session-manager/src/store/store.service.ts`), along with session-level defaults `goal: 5`, `durationMinutes: 10`, `groupSize: 3`.

Changes to a condition in the admin dashboard affect **future sessions only**. Running sessions use the condition snapshot captured at creation time. To run different parameters for a distinct phase of data collection, start a new **study round** (Settings → Study Rounds): sessions are stamped with the round they were created in, so exports can separate the phases (see `docs/data-export.md`).

## Audit and Export

Every intervention is recorded as an `InterventionLog` containing:

- Session and condition IDs
- Delivery mode, audience, and detection arm (`llmMode`)
- Timestamp
- The full contribution split at the time of intervention
- Target(s) and quiet member(s) identified
- The exact message text sent

In addition, the bot records a **`WindowEvaluation` for every window boundary it reaches** — fired or not. Each carries the window's grid index and time span, the detection arm (`arm`: `primary` for normal sessions, `a`/`b` in comparison mode), the outcome (`nudged`, `no-target`, `grace-suppressed`, `baseline-suppressed`, `warm-up`, `wrap-up`, `too-few-participants`), the full contribution split and over-threshold candidates where a split was computed, and a link to the `InterventionLog` when a nudge fired. Baseline sessions therefore carry the same per-window dominance data as the delivery arms (`baseline-suppressed` marks windows where a nudge *would* have fired). Failed LLM classification requests are recorded as `ClassificationFailure` entries, so classifier coverage is auditable. The bot's own nudge messages are stored in the chat log (with `recipientId` set on private nudges) but never count toward contribution scores.

These records are included in the raw exports (`/api/export/sessions`, `/api/export/interventions`), power the dashboard's **Results** tab, and feed the analysis-ready research exports (`/api/export/windows`, `/api/export/research.zip`) — see `docs/data-export.md`.

## Meaningfulness Classifier (Rule + LLM Detection Arm)

Conditions with `llmMode: "active"` (the Rule+LLM arms) classify every
participant message with Anthropic's Messages API. The same API also generates
fresh nudge wording in every non-baseline arm; `ANTHROPIC_API_KEY` must be set
for dynamic wording and Rule+LLM detection. The default model is
`claude-haiku-4-5-20251001` (override via `ANTHROPIC_MODEL`), called with
`temperature: 0` and strict JSON-schema output.
`LLM_MODE` (`off` / `active`) is an optional global override. Per message, the classifier
judges four structural indicators (each `true`/`false` plus a one-sentence
reason), following the study protocol:

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
preceding 3 messages, the ranking-task item list, and the group member list.
Classifications and participant aggregates (per-indicator counts and the mean
meaningfulness score) are available from `/api/export/contributions` and
`/api/export/contributions.csv`.

The API receives pseudonymous color labels,
but it does receive chat text; consent and the data-processing documentation
must state this before the Rule+LLM arms are used with real participants.

## Two-Bot Comparison Mode (pilot / user testing only)

Setting `comparisonMode: true` on a condition (toggle in the admin
**Testing** tab, offered for non-baseline arms only, with a standing "switch
it off before recruiting" warning) runs **both detection arms in the same
room** so testers can compare them live:

| Bot | Matrix user | Detection |
|---|---|---|
| 🤖 Assistant A | `gdm_bot_a_<suffix>` | Rule-based (message + word counts) |
| 🤖 Assistant B | `gdm_bot_b_<suffix>` | Rule-based + LLM meaningfulness (composite score + invite grace) |

Mechanics:

- Each arm runs the full rule engine with its **own** tracker reset and
  grace-period state — each bot behaves as it would alone. One timing
  nuance: Assistant A evaluates immediately at the window boundary, while
  Assistant B evaluates after the up-to-2-second classification wait, so
  B's nudge can land slightly after A's.
- Both follow the **condition's delivery audience**: in a public condition
  everyone sees A and B, in a private condition only the nudged member sees
  them. Each bot gets newly generated wording under the same format and tone
  constraints.
- The labels are neutral (A/B) so testers stay blind to which arm is which;
  the mapping above is the only place it's documented. Every intervention log
  records `llmMode` (`off` = A, `active` = B) for the debrief.
- The primary sync bot stays silent; Assistants A and B are separate Matrix
  users that join on session start. The classifier runs once per message
  (arms share the recorded classifications).
- Never enable this for real study sessions — it exists to pilot the two
  detection approaches against each other.

## Key Source Files

| File | What it does |
|---|---|
| `packages/shared/src/interventions.ts` | Type definitions, defaults, audience/legacy-mode helpers |
| `packages/shared/src/identity.ts` | Color identity assignment |
| `backend/chat-service/src/rules/bot-rules.ts` | The rule engine (`ContributionBotRules`) |
| `backend/chat-service/src/nudge/anthropic-nudge-message-generator.ts` | Fresh nudge wording and output validation |
| `backend/chat-service/src/sessions/session-runtime.ts` | Per-session state, message recording, `post()` / `postPrivate()` |
| `backend/chat-service/src/matrix/matrix-bot.service.ts` | Matrix sync loop, message sending |
