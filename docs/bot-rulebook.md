# Bot Rulebook

How the rule-based intervention bot works, from trigger to message delivery.

## Research Context

The study uses a **2x2 between-subjects design** (public/private x neutral/engaging) to test whether real-time AI nudges during group discussions improve decision quality and group experience. The bot monitors contribution balance and intervenes when one participant dominates the conversation, either by informing the whole group or privately nudging the dominant speaker.

## Experimental Conditions

| Condition | Audience | Tone | Description |
|---|---|---|---|
| `public-neutral` | whole group | informational | Shows the participation split to everyone |
| `public-engaging` | whole group | directive | Shows the split and prompts the top contributor to include quieter members |
| `private-neutral` | target only | informational | Privately shows the participation split to the dominant participant |
| `private-engaging` | target only | directive | Privately shows the split and prompts them to include quieter members |

Each condition is assigned to a session at creation time and cannot change mid-session.

## Intervention Lifecycle

```
Matrix room event (m.room.message)
        |
        v
  Is it inside the intervention window?
  (after protectedStart, before protectedEnd)
        |  no -> stop
        v
  Compute contribution split over rolling window
        |
        v
  Any participant's share >= threshold?
        |  no -> stop
        v
  Has cooldown elapsed for that target?
        |  no -> stop
        v
  Build and send intervention message
        |
        v
  Log intervention to session runtime
```

### Entry Point

`ContributionBotRules.onEvent()` in `backend/chat-service/src/rules/bot-rules.ts` is called for **every timeline event** in an active session's room, except the bot's own events. Only `m.room.message` events proceed past the first check.

### Gate 1: Time Window

No interventions fire during the warm-up or cool-down periods:

- **Protected start** (`protectedStartMinutes`, default 3): no interventions in the first N minutes after the chat room opens.
- **Protected end** (`protectedEndMinutes`, default 2): no interventions in the last N minutes before the timer expires.

This gives participants unmonitored time to settle in and wrap up.

### Gate 2: Contribution Score

Over a rolling window (`contributionWindowMinutes`, default 4 minutes), the bot calculates each participant's contribution:

```
score = messageCount * scoreWeights.messages + characterCount * scoreWeights.characters
share = score / totalScore
```

With default weights (`messages: 1`, `characters: 0.01`), a message counts as 1 point plus 0.01 per character. A 200-character message = 1 + 2 = 3 points.

Only messages within the rolling window are counted. Older messages fall off, so the score reflects recent activity, not cumulative history.

### Gate 3: Threshold

If any participant's `share >= contributionThreshold` (default 0.40), they become a **target**. Multiple participants can exceed the threshold; they are sorted by share descending.

If nobody crosses the threshold, no intervention fires.

### Gate 4: Per-Target Cooldown

Each target is checked against `interventionWindowMinutes` (default 4 minutes). If this target was already intervened on within that window, they are skipped. This prevents the bot from repeatedly nudging the same person.

## Message Templates

### Public Neutral

```
Current participation split:

Blue Jay: 62%, Red Fox: 23%, Green Turtle: 15%.

@all, consider this info as you continue with your conversations.
```

### Public Engaging

```
Current participation split:

Blue Jay: 62%, Red Fox: 23%, Green Turtle: 15%.

@Blue Jay, you are the top contributor right now. Now might be a good
time to check in with group members who did not contribute as much,
such as Green Turtle and Red Fox - you might be missing something useful.
```

### Private Neutral

Same as public neutral, but addressed to the target by name and delivered as a private message (only visible to that participant).

### Private Engaging

Same as public engaging, but delivered as a private message.

## Private Message Delivery

Private nudges are sent to the same Matrix room as regular messages, but with an extra content field (`de.gdm.recipient`) set to the target's Matrix user ID. The participant frontend filters messages: if a message has a `de.gdm.recipient` field, only the matching participant sees it. For public modes, no recipient field is set.

In private mode, each eligible target gets their own separate private message.

## Participant Identities

Participants are not addressed by their real names or Matrix user IDs in bot messages. Instead, the system assigns **color-animal identities** (e.g., "Blue Jay", "Red Fox", "Green Turtle") based on a deterministic mapping from sorted participant user IDs. This is defined in `packages/shared/src/identity.ts`.

## Quiet Members

When the bot sends an engaging message, it identifies the **quietest members** — the participants with the lowest contribution share who are not themselves targets. Up to 2 quiet members are named in the message to direct the target's attention.

## Configurable Parameters

All parameters are editable per condition via the admin dashboard and are stored in the condition's `config` object:

| Parameter | Field | Default | Description |
|---|---|---|---|
| Intervention mode | `interventionMode` | `public-neutral` | Which of the four 2x2 conditions to use |
| Threshold | `contributionThreshold` | `0.40` | Share at which a participant triggers an intervention |
| Protected start | `protectedStartMinutes` | `3` | Minutes of no-intervention warm-up |
| Protected end | `protectedEndMinutes` | `2` | Minutes of no-intervention cool-down |
| Cooldown | `interventionWindowMinutes` | `4` | Minimum minutes between interventions for the same target |
| Score window | `contributionWindowMinutes` | `4` | Rolling window for calculating contribution shares |
| Message weight | `scoreWeights.messages` | `1` | Points per message |
| Character weight | `scoreWeights.characters` | `0.01` | Points per character |

Defaults are defined in `packages/shared/src/interventions.ts` (`DEFAULT_INTERVENTION_CONFIG`). Conditions are seeded with these defaults by the session manager on first startup (see `seedConditions()` in `backend/session-manager/src/store/store.service.ts`).

Changes to a condition in the admin dashboard affect **future sessions only**. Running sessions use the condition snapshot captured at creation time.

## Audit and Export

Every intervention is recorded as an `InterventionLog` containing:

- Session and condition IDs
- Mode, audience, and tone
- Timestamp
- The full contribution split at the time of intervention
- Target(s) and quiet member(s) identified
- The exact message text sent

These logs are visible in the admin dashboard's **Intervention Audit** section and included in the JSON and CSV exports (`/api/export/sessions`, `/api/export/sessions.csv`).

## Key Source Files

| File | What it does |
|---|---|
| `packages/shared/src/interventions.ts` | Type definitions, defaults, audience/tone helpers |
| `packages/shared/src/identity.ts` | Color-animal identity assignment |
| `backend/chat-service/src/rules/bot-rules.ts` | The rule engine (`ContributionBotRules`) |
| `backend/chat-service/src/sessions/session-runtime.ts` | Per-session state, message recording, `post()` / `postPrivate()` |
| `backend/chat-service/src/matrix/matrix-bot.service.ts` | Matrix sync loop, message sending |

## Current Limitations

- **No semantic analysis.** The bot measures volume (messages + characters), not content. It cannot detect whether a contribution was actually acknowledged or engaged with.
- **No baseline condition.** The current seed creates four active conditions. A no-intervention baseline would need a fifth condition with a `NoopBotRules` implementation (which exists in the codebase but is not wired to any condition).
- **Fixed message templates.** The bot messages are hardcoded strings, not LLM-generated. An LLM-based approach is listed as a future deferral.
