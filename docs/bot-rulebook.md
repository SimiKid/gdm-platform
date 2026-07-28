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
validity, and the nudge text is identical everywhere.

## Experimental Conditions

| Condition | Delivery (`interventionMode`) | Detection (`llmMode`) | Description |
|---|---|---|---|
| `baseline` | baseline | off | No bot intervention; messages are recorded but the bot stays silent |
| `public-rule` | public | off | Public nudges, rule-based detection |
| `public-llm` | public | active | Public nudges, rule + LLM meaningfulness detection |
| `private-rule` | private | off | Private nudges, rule-based detection |
| `private-llm` | private | active | Private nudges, rule + LLM meaningfulness detection |

Per the study protocol, the nudge **text is identical across all non-baseline
conditions** — only the delivery (public vs. private) differs, so the message
itself cannot confound the comparison. (An earlier neutral/engaging tone axis
was retired; conditions persisted with old mode strings like
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
        |  no -> stop
        v
  Compute contribution split over the closed window
  (messages after the last tracker reset only)
        |
        v
  Any participant's dominance score >= threshold?
  (skipping members in an invite grace period)
        |  no -> stop
        v
  Is mode "baseline"? ── yes ──> stop (no intervention)
        |  no
        v
  Build and send intervention message to the top target
        |
        v
  Reset contribution tracker; log intervention
```

### Entry Points

`ContributionBotRules.onEvent()` in `backend/chat-service/src/rules/bot-rules.ts` is called for **every timeline event** in an active session's room, except the bot's own events; it only observes (records and, with an LLM arm, classifies messages). `ContributionBotRules.onWindowElapsed()` is called by the session service's per-session window timer at each boundary (aligned to the end of the warm-up, so restarts resume the same window grid) and decides the nudges.

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

If nobody crosses the threshold, no intervention fires.

### Gate 4: Tracker Reset

Sending a nudge stamps the reset point: all messages up to and including that
moment are wiped from future dominance calculations, so the tracker restarts
at parity ("back to 20-20-20-20-20"). The goal is equal turns from now on,
not an equally balanced whole session — a dominant member who keeps dominating
after a reset is flagged again at the end of the next window.

## Message Templates

Five friendly variants (study protocol), rotated deterministically per nudge
(1st nudge → variant 1, 2nd → variant 2, …). Each names **only the target and
their own percentage** — the other members' shares are never revealed to
participants (they remain in the audit log for analysis):

```
1. @Red, you've brought a lot of energy to this — 72% of the airtime so far!
   Might be a good moment to hear from the others, too.
2. @Red, you're leading the discussion right now at 72% of the messages.
   Curious what the rest of the group thinks — want to pull them in?
3. Nice momentum, @Red — you're at 72% of the conversation so far. The group
   might benefit from a few more voices in the mix.
4. @Red, you've been really active — 72% of the airtime! Worth checking in
   with the quieter folks before you move on?
5. @Red, you've carried a good chunk of this discussion (72%). Maybe toss the
   next question over to someone else in the group?
```

The percentage is the target's **raw contribution share** (airtime), not the
composite dominance score. Public and private conditions send the identical
text; only visibility differs.

## Private Message Delivery

Private nudges are sent to the same Matrix room as regular messages, but with an extra content field (`de.gdm.recipient`) set to the target's Matrix user ID. The participant frontend filters messages: if a message has a `de.gdm.recipient` field, only the matching participant sees it. For public modes, no recipient field is set.

Every bot message carries a prominent Zoom-style delivery badge so
participants are never unsure who can see a nudge:

- Private: **🔒 Private message to you — only you can see this**
- Public: **📢 Message to ALL in the group**

In private mode, the single selected target gets the private message; exactly
one nudge is sent per trigger in both delivery modes.

## Participant Identities

Participants are not addressed by their real names or Matrix user IDs in bot messages. Instead, the system assigns **color-animal identities** (e.g., "Blue Jay", "Red Fox", "Green Turtle") based on a deterministic mapping from sorted participant user IDs. This is defined in `packages/shared/src/identity.ts`.

## Quiet Members (audit only)

Each intervention log records the **quietest members** — up to 2 participants with the lowest contribution share whose dominance score is below the threshold and who are not the target. They are **never named in the participant-facing nudge** anymore; the field exists purely for analysis.

## Configurable Parameters

All parameters are editable per condition via the admin dashboard and are stored in the condition's `config` object:

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
| Two-bot test | `comparisonMode` | `false` | Pilot only: both detection bots nudge side by side (see below) |

Defaults are defined in `packages/shared/src/interventions.ts` (`DEFAULT_INTERVENTION_CONFIG`). Conditions are seeded with these defaults by the session manager on first startup (see `seedConditions()` in `backend/session-manager/src/store/store.service.ts`).

Changes to a condition in the admin dashboard affect **future sessions only**. Running sessions use the condition snapshot captured at creation time.

## Audit and Export

Every intervention is recorded as an `InterventionLog` containing:

- Session and condition IDs
- Delivery mode, audience, and detection arm (`llmMode`)
- Timestamp
- The full contribution split at the time of intervention
- Target(s) and quiet member(s) identified
- The exact message text sent

These logs are visible in the admin dashboard's **Intervention Audit** section and included in the JSON and CSV exports (`/api/export/sessions`, `/api/export/sessions.csv`).

## Meaningfulness Classifier (Rule + LLM Detection Arm)

Conditions with `llmMode: "active"` (the Rule+LLM arms) classify every
participant message with Anthropic's Messages API; `ANTHROPIC_API_KEY` must
be set for these arms to run.
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

Setting `comparisonMode: true` on a condition (admin Settings → "2-bot test")
runs **both detection arms in the same room** so testers can compare them
live:

| Bot | Matrix user | Detection |
|---|---|---|
| 🤖 Assistant A | `gdm_bot_a_<suffix>` | Rule-based (message + word counts) |
| 🤖 Assistant B | `gdm_bot_b_<suffix>` | Rule-based + LLM meaningfulness (composite score + invite grace) |

Mechanics:

- Each arm runs the full rule engine with its **own** tracker reset and
  grace-period state — each bot behaves exactly as it would alone, so their
  nudge timing can be compared directly.
- Both follow the **condition's delivery audience**: in a public condition
  everyone sees A and B, in a private condition only the nudged member sees
  them. Both use the same 5 rotating templates (each rotates independently).
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
| `packages/shared/src/identity.ts` | Color-animal identity assignment |
| `backend/chat-service/src/rules/bot-rules.ts` | The rule engine (`ContributionBotRules`) |
| `backend/chat-service/src/sessions/session-runtime.ts` | Per-session state, message recording, `post()` / `postPrivate()` |
| `backend/chat-service/src/matrix/matrix-bot.service.ts` | Matrix sync loop, message sending |

## Current Limitations

- Participant-visible bot messages remain fixed templates rather than LLM-generated text.
