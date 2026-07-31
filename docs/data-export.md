# Data Export

All exports are available from the **Admin Dashboard**. No scripting is required, every endpoint returns a file the browser downloads directly.

- **Overview tab → Export Data**: the raw exports below (two top-level downloads and four focused sub-exports).
- **Results tab → Research Exports**: the [analysis-ready research exports](#research-exports-analysis-ready) — pseudonymized, joined tables plus a one-click ZIP bundle with a codebook. This is what the TA/analyst normally downloads.

Every endpoint accepts `?conditionIds=a,b,c` to restrict the export to specific study arms (e.g. `baseline,public-llm,private-llm`). Sessions from automated `e2e-…` test conditions are always excluded.

---

## Researcher workflow

**1. During data collection — monitor.** Overview shows live sessions, per-condition completion, and the study link for recruitment. The Results tab shows per-arm descriptives (completed n, entry/exit survey return rates, mean group ranking error vs. the NASA expert solution, satisfaction, participation equality, nudges per session) — use it to catch problems early (an arm with low exit-survey returns, nudges never firing), not for inference. Settings → Recruiting toggles arms; goals auto-stop recruiting when reached.

**2. Study done — one download.** Results tab → **Research Bundle (ZIP + codebook)**. Restrict to specific arms by appending `?conditionIds=…` to the URL, or filter the `condition_id` column later. The bundle is fully pseudonymized and safe to share within the team (and as supplementary data), with `codebook.md` inside documenting every column.

**3. Analysis — each file answers one level of question.**

| File | Level | Typical question |
|---|---|---|
| `participants.csv` | Individual | Felt heard? Ranking accuracy? How much did each person speak, how many nudges did they get? (mixed model, `session_pseudonym` as grouping factor) |
| `sessions_analysis.csv` | Group | Did the bot equalize participation (`share_std_dev`, `share_gini`)? Better group ranking (`group_ranking_error`)? |
| `windows.csv` | Time | Dominance dynamics per contribution window across all arms — baseline included via `baseline-suppressed` counterfactual rows |
| `messages.csv` | Transcript | Qualitative coding, manipulation checks |

**4. Compensation & exclusions — the only step that touches identity.** Download `linkage.csv` separately (Results tab, bottom). Match Prolific tokens to approve payments; to exclude a participant, note their pseudonym and drop that row from the analysis files. The linkage file never enters the analysis folder and is never shared.

The raw exports below remain the escape hatch when the analyst needs something the research files omit (raw Matrix IDs, reaction data, full LLM classifier prompts/outputs).

---

## Top-level downloads

### Full Data (JSON): `detailed_data.json`

**Endpoint:** `GET /api/export/sessions`

The most complete export. Contains every session as a nested JSON object with all sub-records embedded. Use this when you need the full picture or when writing analysis scripts.

```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "sessions": [
    {
      "id": "session-uuid",
      "status": "completed",
      "createdAt": "2026-07-13T10:00:00Z",
      "startedAt": "2026-07-13T10:05:00Z",
      "completedAt": "2026-07-13T10:35:00Z",
      "durationMinutes": 30,

      "condition": {
        "id": "cond-1",
        "name": "Baseline",
        "active": false,
        "goal": 5,
        "durationMinutes": 30,
        "groupSize": 5,
        "config": { "interventionMode": "baseline", "llmMode": "off" }
      },

      "participants": [
        {
          "id": "participant-uuid",
          "name": "blue",
          "trackingToken": "prolific-token",
          "entrySurvey": {
            "submittedAt": "2026-07-13T10:04:00Z",
            "answers": { "q1": 4, "q2": "agree", "ranking": ["B","C","A","D","E"] }
          },
          "exitSurvey": {
            "submittedAt": "2026-07-13T10:36:00Z",
            "answers": { "fairness": 5, "cohesion": 4, "ai_perception": 3 }
          }
        }
      ],

      "chat": {
        "messages": [
          {
            "id": "msg-uuid",
            "timestamp": "2026-07-13T10:07:00Z",
            "senderId": "participant-uuid",
            "recipientId": null,
            "text": "I think candidate B is strong because of their project management background.",
            "reactions": [
              { "key": "👍", "senderId": "participant-uuid-2", "timestamp": "2026-07-13T10:07:30Z" }
            ]
          }
        ]
      },

      "interventions": [
        {
          "sessionId": "session-uuid",
          "conditionId": "cond-2",
          "timestamp": "2026-07-13T10:15:00Z",
          "mode": "public",
          "audience": "public",
          "trigger": "contribution-threshold",
          "threshold": 0.4,
          "llmMode": "off",
          "targets": [{ "identityName": "blue" }],
          "quietMembers": [{ "identityName": "red" }],
          "message": "Blue raised a point that hasn't been addressed yet."
        }
      ],

      "rankingHistory": [
        {
          "taskId": "nasa-task",
          "order": ["B", "C", "A", "D", "E"],
          "updatedAt": "2026-07-13T10:20:00Z",
          "updatedBy": "participant-uuid"
        }
      ],

      "behavioralEvents": [
        {
          "id": "evt-uuid",
          "type": "tab-hidden",
          "participantId": "participant-uuid",
          "timestamp": "2026-07-13T10:12:00Z",
          "durationMs": 3000,
          "payload": {}
        }
      ],

      "contributionClassifications": [
        {
          "messageId": "msg-uuid",
          "senderId": "participant-uuid",
          "classifiedAt": "2026-07-13T10:07:05Z",
          "respondsToPrior": { "value": true, "reason": "Agrees with Red's oxygen proposal." },
          "referencesTaskItem": { "value": true, "reason": "Names the oxygen tanks." },
          "hasDiscussionStructure": { "value": false, "reason": "No explicit stance or proposal." },
          "invitesParticipation": { "value": false, "reason": "Does not address another member." },
          "meaningfulnessScore": 0.667,
          "model": "claude-haiku-4-5-20251001",
          "promptVersion": "meaningfulness-v1"
        }
      ]
    }
  ]
}
```

**Behavioral event types**

| `type` | Meaning |
|---|---|
| `typing-start` | Participant started typing |
| `typing-stop` | Participant stopped typing |
| `tab-hidden` | Browser tab left / participant switched away |
| `tab-visible` | Browser tab returned |
| `cursor-activity` | Mouse/cursor movement recorded |
| `ranking-move` | Participant dragged an item in the shared ranking |

---

### Overview (CSV): `overview.csv`

**Endpoint:** `GET /api/export/sessions.csv`

One row per session. Intended for a quick overview of study progress and session-level counts. Open directly in Excel or Numbers.

| Column | Description |
|---|---|
| `session_id` | Unique session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Human-readable condition name (e.g. "Baseline") |
| `status` | `waiting`, `running`, `completed`, or `aborted` |
| `participant_count` | Number of participants who joined |
| `message_count` | Total messages sent in the session (includes bot nudges, which are recorded in the chat log) |
| `reaction_count` | Total emoji reactions across all messages (always 0 since the reaction UI was removed per study protocol; kept for schema stability) |
| `ranking_edit_count` | Number of times the shared ranking was modified |
| `intervention_count` | Number of bot nudges fired |
| `created_at` | ISO 8601 timestamp, session created |
| `started_at` | ISO 8601 timestamp, chat room opened |
| `completed_at` | ISO 8601 timestamp, session ended |

---

## Individual dataset exports

Available via the **Individual datasets** dropdown in the Export Data card. Each has a JSON and a CSV variant.

---

### Chat logs

**Endpoints:** `GET /api/export/messages` (JSON) · `GET /api/export/messages.csv` (CSV)

One record per chat message across all sessions.

**JSON structure**
```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "messages": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-1",
      "conditionName": "Baseline",
      "id": "msg-uuid",
      "timestamp": "2026-07-13T10:07:00Z",
      "senderId": "participant-uuid",
      "recipientId": null,
      "text": "I think candidate B is strong because of their project management background.",
      "reactions": [
        { "key": "👍", "senderId": "participant-uuid-2", "timestamp": "2026-07-13T10:07:30Z" }
      ]
    }
  ]
}
```

> Bot messages are part of the chat log: `sender_id` is then the bot's Matrix id. `recipientId` is `null` for group messages; when set, the message is a private bot nudge rendered only to that participant. Bot messages never count toward contribution scores or shares.

**CSV columns**

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Condition name |
| `message_id` | Message identifier |
| `timestamp` | ISO 8601 send time |
| `sender_id` | Participant or bot identifier |
| `recipient_id` | Empty for group messages; participant id for private bot nudges |
| `text` | Full message text |
| `reaction_count` | Number of reactions on this message |
| `reaction_keys` | Pipe-separated reaction keys, e.g. `👍\|❤️` |

---

### Nudge events

**Endpoints:** `GET /api/export/interventions` (JSON) · `GET /api/export/interventions.csv` (CSV)

One record per bot intervention across all sessions.

**JSON structure**
```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "interventions": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-2",
      "conditionName": "Public Neutral",
      "timestamp": "2026-07-13T10:15:00Z",
      "mode": "public",
      "audience": "public",
      "trigger": "contribution-threshold",
      "threshold": 0.4,
      "llmMode": "off",
      "targets": [{ "identityName": "blue" }],
      "quietMembers": [{ "identityName": "red" }],
      "message": "Blue raised a point that hasn't been addressed yet."
    }
  ]
}
```

**CSV columns**

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Condition name |
| `timestamp` | ISO 8601 time the nudge was sent |
| `mode` | Delivery: `public` or `private` |
| `audience` | `public` or `private` |
| `trigger` | What caused the nudge (`contribution-threshold`) |
| `threshold` | Dominance-score threshold that was exceeded (0..1) |
| `llm_mode` | Detection arm: `off` (rule-based) or `active` (composite score) |
| `targets` | Pipe-separated identity names of nudged participants |
| `quiet_members` | Pipe-separated identity names of participants whose contribution was low |
| `message` | The exact text the bot sent |

---

### Survey responses

**Endpoints:** `GET /api/export/surveys` (JSON) · `GET /api/export/surveys.csv` (CSV)

One record per participant per survey kind (`entry` or `exit`).

**JSON structure**
```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "surveys": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-1",
      "conditionName": "Baseline",
      "participantId": "participant-uuid",
      "participantName": "blue",
      "trackingToken": "prolific-token",
      "kind": "entry",
      "submittedAt": "2026-07-13T10:04:00Z",
      "answers": {
        "q1": 4,
        "q2": "agree",
        "ranking": ["B", "C", "A", "D", "E"]
      }
    }
  ]
}
```

> `answers` keys match the question ids defined in the study configuration. The `ranking` key (when present) holds the participant's individual ranking of candidates as an ordered array.

**CSV columns**

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Condition name |
| `participant_id` | Participant identifier |
| `participant_name` | Anonymous colour-based identity name (e.g. "blue") |
| `tracking_token` | Prolific or external tracking token for payment |
| `kind` | `entry` or `exit` |
| `submitted_at` | ISO 8601 submission time |
| `answers_json` | All answers serialised as a JSON string. Use the JSON export for easier parsing. |

---

### Contributions & behavioral telemetry

**Endpoints:** `GET /api/export/contributions` (JSON) · `GET /api/export/contributions.csv` (CSV)

The JSON export contains three arrays. The CSV contains only the aggregate contribution scores (first array).

**JSON structure**
```json
{
  "generatedAt": "2026-07-13T10:00:00Z",

  "contributions": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-1",
      "participantId": "participant-uuid",
      "messageCount": 12,
      "characterCount": 840,
      "reactionCount": 5,
      "rankingMoveCount": 3,
      "typingDurationMs": 42000,
      "respondsToPriorCount": 8,
      "referencesTaskItemCount": 6,
      "hasDiscussionStructureCount": 5,
      "invitesParticipationCount": 2,
      "meaningfulnessScoreMean": 0.58
    }
  ],

  "behavioralEvents": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-1",
      "id": "evt-uuid",
      "type": "typing-start",
      "participantId": "participant-uuid",
      "timestamp": "2026-07-13T10:07:00Z",
      "durationMs": 4200,
      "payload": {}
    }
  ],

  "classifications": [
    {
      "sessionId": "session-uuid",
      "conditionId": "cond-1",
      "messageId": "msg-uuid",
      "senderId": "participant-uuid",
      "classifiedAt": "2026-07-13T10:07:05Z",
      "respondsToPrior": { "value": true, "reason": "Agrees with Red's oxygen proposal." },
      "referencesTaskItem": { "value": true, "reason": "Names the oxygen tanks." },
      "hasDiscussionStructure": { "value": false, "reason": "No explicit stance or proposal." },
      "invitesParticipation": { "value": false, "reason": "Does not address another member." },
      "meaningfulnessScore": 0.667,
      "model": "claude-haiku-4-5-20251001",
      "promptVersion": "meaningfulness-v1"
    }
  ]
}
```

**`contributions` fields**

| Field | Description |
|---|---|
| `messageCount` | Total messages sent by this participant |
| `characterCount` | Total characters across all messages |
| `reactionCount` | Total emoji reactions given by this participant |
| `rankingMoveCount` | Number of times this participant moved an item in the shared ranking |
| `typingDurationMs` | Total milliseconds spent typing (from behavioral events) |
| `respondsToPriorCount` | Messages that address, react to, or build on a prior message/member |
| `referencesTaskItemCount` | Messages that explicitly name a ranking-task item |
| `hasDiscussionStructureCount` | Messages with an explicit stance, proposal, or structured discourse move |
| `invitesParticipationCount` | Messages that explicitly invite another member to contribute |
| `meaningfulnessScoreMean` | Mean `meaningfulnessScore` across this participant's classified messages (0..1) |

**`classifications` fields**

| Field | Description |
|---|---|
| `respondsToPrior` | `{ value, reason }` — addresses, reacts to, builds on, or refers to a specific prior message or member |
| `referencesTaskItem` | `{ value, reason }` — explicitly names one or more ranking-task items |
| `hasDiscussionStructure` | `{ value, reason }` — explicit stance, proposal, or structured discourse move |
| `invitesParticipation` | `{ value, reason }` — explicitly invites another member to contribute. Tracked separately; never part of the meaningfulness score. |
| `meaningfulnessScore` | Mean of the first three indicator values (0, 1/3, 2/3, or 1) |

**CSV columns** (aggregate scores only; use the JSON export for behavioral events and per-message classifications)

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `participant_id` | Participant identifier |
| `message_count` | Total messages sent |
| `character_count` | Total characters written |
| `reaction_count` | Total reactions given |
| `ranking_move_count` | Shared ranking edits made |
| `typing_duration_ms` | Total typing time in milliseconds |
| `responds_to_prior_count` | Messages addressing or building on a prior message/member |
| `references_task_item_count` | Messages naming a ranking-task item |
| `has_discussion_structure_count` | Messages with an explicit stance or proposal |
| `invites_participation_count` | Messages inviting another member to contribute |
| `meaningfulness_score_mean` | Mean meaningfulness score across classified messages (0..1) |

---

## Research exports (analysis-ready)

Available from the **Results tab → Research Exports** section. These are the files intended for statistical analysis: identifiers are **pseudonymous** (`P-xxxxxxxx` for participants, `S-xxxxxxxx` for sessions — the first 8 hex chars of SHA-256 over the internal UUID, stable across re-downloads), surveys and activity are pre-joined, and derived measures (ranking scores, participation equality) are computed server-side. Bot senders appear as `BOT` (`BOT-A`/`BOT-B` in pilot comparison sessions).

**One-click bundle:** `GET /api/export/research.zip` → `research_bundle.zip`, containing `participants.csv`, `sessions_analysis.csv`, `windows.csv`, a pseudonymized `messages.csv`, and `codebook.md` — a generated data dictionary documenting every column, the NASA scoring rule and expert key, the equality metrics, and the window-outcome glossary. The linkage file is deliberately **not** in the bundle.

### Participants

**Endpoints:** `GET /api/export/participants` (JSON) · `GET /api/export/participants.csv`

One row per participant: condition (from the session's frozen snapshot), entry-survey demographics and scales, exit-survey outcomes (`satisfaction`, `fairness`, `felt_heard`), NASA ranking error scores for the individual entry ranking (only when explicitly completed) and the exit final ranking, chat activity (`message_count`, `word_count`, `contribution_share`), LLM classifier aggregates, nudges received (total/public/private), and behavioral aggregates (`typing_duration_ms`, `tab_hidden_count`, `ranking_move_count`).

### Sessions (analysis)

**Endpoints:** `GET /api/export/sessions-analysis` (JSON) · `GET /api/export/sessions-analysis.csv` → `sessions_analysis.csv`

One row per session: condition and status, `group_ranking_error` (NASA score of the final shared ranking — read together with `ranking_edit_count`), participation-equality metrics (`share_std_dev`, `share_gini`), message/word counts split into participant vs. bot, intervention counts by audience, window-outcome counts, classification coverage (`classification_count`, `classification_failure_count`), and exit-survey means.

### Contribution windows

**Endpoints:** `GET /api/export/windows` (JSON) · `GET /api/export/windows.csv`

The bot records **every** evaluated contribution-window boundary, not just fired nudges — including baseline sessions, where `baseline-suppressed` rows show when a nudge *would* have fired. The CSV is long format (one row per window × participant, ready for mixed-effects models); the JSON nests the per-participant split inside each window record. Outcomes: `nudged`, `no-target`, `grace-suppressed`, `baseline-suppressed`, `warm-up`, `wrap-up`, `too-few-participants`. Only sessions run after this instrumentation was deployed have window records.

### Linkage (identifying — handle with care)

**Endpoint:** `GET /api/export/linkage.csv`

Maps `participant_pseudonym`/`session_pseudonym` back to the internal UUIDs, the Prolific `tracking_token`, and the Matrix user id. Needed for compensation and exclusions only. Keep it out of analysis folders and never share it with the analysis dataset; it is excluded from the research bundle by design.

### Results summary (dashboard)

**Endpoint:** `GET /api/reports/summary`

Per-condition descriptives backing the Results tab: session/participant/survey counts by status, and means over completed sessions for group ranking error, entry/exit individual ranking errors, satisfaction/fairness/felt-heard, share SD/Gini, nudges per session, and windows evaluated/nudged. Monitoring only — the CSVs are the citable record.
