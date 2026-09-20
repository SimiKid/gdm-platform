# Data Export

Questionnaire timeouts are recorded in raw survey answers as
`entryQuestionnaireTimedOut` and `exitQuestionnaireTimedOut`. Unanswered questions
are omitted, rather than encoded as zero. Exit ranking answers also include
`finalRankingTimedOut` and `finalRankingCompleted`. If the two-minute ranking
deadline expires with items still unranked, the entered order is saved as
`finalRankingPartial`; `finalRanking` is absent so existing ranking scores do not
treat an unfinished order as complete. These metadata fields are available in raw
survey/full-data exports; the fixed analysis CSV columns are unchanged.

Every export is a `GET` endpoint of the Session Manager under `/api/export/…`, guarded by `ADMIN_API_TOKEN` (`Authorization: Bearer …`). The admin dashboard links the ones researchers normally need; the others are reachable by URL only (from the browser while logged into the dashboard, or with `curl -H "Authorization: Bearer $ADMIN_API_TOKEN"`).

Where the downloads live in the dashboard:

- **Overview tab → Export Data**: one primary button, **Research Data (CSV)** (`research_data.zip`: the wide `results.csv` plus a flat `messages.csv`), and an "Advanced" fold-out with the **Full data dump** JSON.
- **Results tab → Research Exports**: the [pseudonymized research exports](#research-exports-analysis-ready) — a one-click **Research Bundle (ZIP + codebook)** and, under "Individual research datasets", the four analysis files as JSON or CSV. The **Identifying Data** section below it downloads `linkage.csv`.
- Not linked anywhere (URL only): `overview.csv`, `detailed_overview.csv`, and the raw messages / interventions / surveys / contributions exports, plus the two Prolific exports.

Every research and raw export accepts `?conditionIds=a,b,c` to restrict the export to specific study arms (e.g. `baseline,public-llm,private-llm`) and `?roundIds=1,2` to restrict to specific study rounds; both compose. Sessions from automated `e2e-…` test conditions are always excluded. Note the failure modes of `roundIds`: non-numeric or non-positive values are silently ignored (so `?roundIds=abc` returns **all** rounds, not none), while a valid but non-existent round number returns an empty dataset with HTTP 200. The two exceptions are `GET /api/export/prolific-arrivals` and `GET /api/export/prolific-outcomes`, which take no filters and are not e2e-filtered (they are not session-based).

Download filenames: the server sets a `Content-Disposition` filename (given below per endpoint). The dashboard's download links fetch the file with the token and save it under the same name, so a file downloaded through the dashboard and one fetched from the API directly are named identically.

---

## Researcher workflow

**1. During data collection — monitor.** Overview shows the current round, live sessions, per-condition completion for the current round, and the study link for recruitment. The Results tab shows per-arm descriptives (completed n and running n, participants, entry/exit survey submission counts, mean group ranking error vs. the NASA expert solution, mean satisfaction / fairness / felt heard, share SD, nudges per session, windows evaluated and nudged) — use it to catch problems early (an arm with low exit-survey returns, nudges never firing), not for inference. Reading notes: the participant and survey figures are raw counts over **all** sessions in the filter (including waiting/aborted), while the means on the same row are over completed sessions only; the satisfaction / fairness / felt-heard means come from the legacy exit-survey keys and stay `n/a` for data collected with the current exit survey (see [Survey responses](#survey-responses)); and a round filter does not shrink the condition list — arms with no sessions in the selected rounds still appear as all-zero rows. Settings → Recruiting toggles arms; goals auto-stop recruiting when reached.

**2. Study done — one download.** Results tab → **Research Bundle (ZIP + codebook)**. With the round chips you get a per-round bundle or the whole study. Restrict to specific arms by appending `?conditionIds=…` to the URL, or filter the `condition_id` column later. The bundle is fully pseudonymized and safe to share within the team (and as supplementary data), with `codebook.md` inside documenting the files (a full column table for `participants.csv`; prose descriptions of the derived measures for the other files).

**3. Analysis — each file answers one level of question.**

| File | Level | Typical question |
|---|---|---|
| `participants.csv` | Individual | Ranking accuracy? Group-dynamics, psychological-safety and bot-perception ratings? How much did each person speak, how many nudges did they get? Includes `recruitment_source` (`direct` or `prolific`) for recruitment-channel filtering. |
| `sessions_analysis.csv` | Group | Did the bot equalize participation (`share_std_dev`, `share_gini`)? Better group ranking (`group_ranking_error`)? |
| `windows.csv` | Time | Dominance dynamics per contribution window across all arms — baseline included via `baseline-suppressed` counterfactual rows |
| `rankings.csv` | Item | Raw ranking orders (entry/exit individual, every group edit, group final) — item-level misplacement and convergence analyses |
| `messages.csv` | Transcript | Qualitative coding, manipulation checks |

**4. Compensation & exclusions — the only step that touches identity.** Download `linkage.csv` separately (Results tab, bottom). Match Prolific tokens to approve payments; to exclude a participant, note their pseudonym and drop that row from the analysis files. The linkage file never enters the analysis folder and is never shared. The Overview tab's **Research Data (CSV)** zip is also identifying (it carries the raw Prolific participant id and session UUIDs) — treat it like `linkage.csv`.

**Running the study in rounds.** The study can run in numbered rounds, possibly with different Session & Bot Parameters per round. Start a new round in **Settings → Study Rounds** (optionally with a label like "threshold 35%" — labels can also be edited after the round started): every arm's recruiting progress restarts at 0 / goal, **all** open waiting-room lobbies are aborted so groups never mix rounds (the confirmation prompt shows how many lobbies are open; the API response reports how many were aborted), and running sessions finish in their round — then adjust the shared parameters if the new round differs. Note the recruiting goal itself is one number per arm, not per round; progress against the goal is only shown for the current round (the Study Rounds table lists sessions and completed sessions per past round without a goal). Every session is stamped with its round: the Overview shows the current round and a Round column, and the Results tab's round chips (shown once more than one round exists) filter both the descriptives table and **every** Results-tab download link (so a per-round bundle or the overall dataset is one click). All research export files, all raw exports (`round` column in every CSV except `detailed_overview.csv`, which names it `round_id`; `roundId` in every JSON record), and `linkage.csv` carry the round. The Overview-tab downloads (`research_data.zip`, full JSON dump) always contain all rounds — append `?roundIds=…` to the URL by hand if needed. Sessions collected before the rounds feature existed are retroactively stamped Round 1 by the migration, so "round = 1" does not by itself mean a deliberate round-1 protocol. Per-round parameter values are reconstructable from each session's frozen condition snapshot (`detailed_overview.csv` lists it per session; `windows.csv` rows carry their own `window_minutes`/`threshold`).

The rounds API behind the Settings UI: `GET /api/rounds` (returns `{ currentRound, rounds }` with per-round `sessionCount` and `completedCount`, e2e conditions excluded), `POST /api/rounds` (start a new round; body `{ label? }`; returns `{ round, abortedWaitingSessions }`), `PUT /api/rounds/:number` (edit a round's label).

The raw exports below remain the escape hatch when the analyst needs something the research files omit (raw Matrix IDs, reaction data, full LLM classifier prompts/outputs). One join caveat: `participant_id` in the contributions export is the **Matrix user id** (rows are collected from message and reaction senders, behavioral events, and classifications), not the internal participant UUID used by the surveys/linkage exports — join via `linkage.csv`'s Matrix id column, and note that participants who never sent a message or event get no contributions row at all.

---

## Overview-tab downloads

### Research Data (CSV): `research_data.zip`

**Endpoint:** `GET /api/export/research-data.zip`

The Overview tab's primary download. A zip with two **non-pseudonymized** wide-format files built for a spreadsheet-style workflow:

- `results.csv` — one row per participant: `prolific_id` (raw Prolific participant id, empty for direct participants), `group_id` (session UUID), `member_id` (1-based position in the session), `condition` (condition name), `round`, `session_status` (`1` completed / `0` otherwise), `age`, `gender`, `education`, `english`, `gaais1`–`gaais10`, `person1`–`person10` (TIPI items), `team` (teamwork frequency), `text` (chat comfort), `space` (spaceflight familiarity), `survival` (survival familiarity), `rank_true` (expert order), `rank_init` (entry individual ranking), `rank_fin` (exit individual ranking), `rank_group` (final shared ranking) — all four as pipe-joined item ids — `rank_completed`, `confidence` (task confidence), `groupcoh1`–`groupcoh5` (group considered / balanced / dominated / felt team / comfortable again), `psysafe1`–`psysafe6` (safe to speak up / raise concerns / contradicted / contribution serious / contribution influenced / held back), `attention1`, `attention2`, `feedback` (debrief free text), `message_count`, `character_count`, `intervention_count`, `intervention_id` (pipe-joined ids of the nudges that targeted this participant).
- `messages.csv` — one row per chat message: `session_id`, `group_id` (same UUID), `condition`, `round`, `message_id`, `timestamp`, `member_id` (empty for bot messages), `sender_is_bot`, `intervention_id` (for bot messages, the intervention whose text matches), `text`, `word_count`.

Because `results.csv` contains the Prolific id, keep this zip with the identifying data, not in the analysis folder.

### Full Data (JSON): `detailed_data.json`

**Endpoint:** `GET /api/export/sessions`

The most complete export. Contains every session as a nested JSON object with all sub-records embedded. Use this when you need the full picture or when writing analysis scripts.

The example below is **abridged**: each session object additionally embeds `bot`, `briefing`, `rankingTask`, `ranking` (the current shared ranking), `polls`, `roomId`, `waitingDeadlineAt`, `windowEvaluations` (one record per evaluated window boundary — the source of `windows.csv`), `classificationFailures` (failed classifier calls), `reactionEvents` / `redactedReactionEventIds`, and internal checkpoint fields (`processedEventIds`, `runtimeState`, `checkpointRevision`). Each participant additionally carries `recruitmentSource` (`direct` / `prolific`), an optional `prolific` identity (`participantId`, `studyId`, `sessionId`), and `completedAt` once their exit survey is stored.

```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "sessions": [
    {
      "id": "session-uuid",
      "status": "completed",
      "roundId": 1,
      "createdAt": "2026-07-13T10:00:00Z",
      "startedAt": "2026-07-13T10:05:00Z",
      "completedAt": "2026-07-13T10:35:00Z",
      "durationMinutes": 10,

      "condition": {
        "id": "baseline",
        "name": "Baseline",
        "active": false,
        "goal": 5,
        "durationMinutes": 10,
        "groupSize": 3,
        "config": { "interventionMode": "baseline", "llmMode": "off" }
      },

      "participants": [
        {
          "id": "participant-uuid",
          "name": "",
          "matrixUserId": "@gdm_user_abc:synapse",
          "trackingToken": "prolific-token",
          "recruitmentSource": "prolific",
          "prolific": { "participantId": "…", "studyId": "…", "sessionId": "…" },
          "completedAt": "2026-07-13T10:36:30Z",
          "entrySurvey": {
            "submittedAt": "2026-07-13T10:04:00Z",
            "answers": {
              "consentAdult": true, "consentInformed": true, "consentParticipation": true,
              "age": 29, "gender": "woman", "education": "bachelors",
              "englishProficiency": "fluent",
              "gaais1": 4, "…": "…", "gaais10": 2,
              "tipi1": 5, "…": "…", "tipi10": 3,
              "teamworkFrequency": "sometimes", "chatComfort": 4,
              "spaceflightFamiliarity": 2, "survivalFamiliarity": 3,
              "individualRanking": ["oxygen", "water", "map", "…"],
              "rankingCompleted": true,
              "rankingSecondsUsed": 212,
              "groupInstructionsAcknowledged": true
            }
          },
          "exitSurvey": {
            "submittedAt": "2026-07-13T10:36:00Z",
            "answers": {
              "finalRanking": ["oxygen", "water", "flares", "…"],
              "taskConfidence": 4,
              "groupConsidered": 4, "groupBalanced": 3, "attentionCheck1": 1,
              "groupDominated": 2, "feltTeam": 4, "comfortableAgain": 5,
              "safeSpeakUp": 5, "raiseConcerns": 4, "contradicted": 3,
              "attentionCheck2": 4, "contributionSerious": 4,
              "contributionInfluenced": 3, "heldBack": 2,
              "botIntrusive": 2, "botHelpful": 4, "botAppropriate": 4,
              "botObserved": 3, "botSupport": 3,
              "debriefFeedback": "Optional free text from the debriefing page"
            }
          }
        }
      ],

      "chat": {
        "messages": [
          {
            "id": "msg-uuid",
            "timestamp": "2026-07-13T10:07:00Z",
            "senderId": "@gdm_user_abc:synapse",
            "recipientId": null,
            "text": "I'd put the oxygen tanks first — nothing else matters if we can't breathe.",
            "reactions": []
          }
        ]
      },

      "interventions": [
        {
          "id": "intervention-uuid",
          "sessionId": "session-uuid",
          "roomId": "!room-id:synapse",
          "conditionId": "public-llm",
          "timestamp": "2026-07-13T10:15:00Z",
          "mode": "public",
          "audience": "public",
          "trigger": "contribution-threshold",
          "threshold": 0.4,
          "llmMode": "active",
          "contributionWindowMinutes": 4,
          "contributionSplit": [
            {
              "userId": "@gdm_user_abc:synapse", "identityName": "Blue",
              "messageCount": 9, "wordCount": 140, "score": 16,
              "share": 0.72, "meaningfulnessScore": 0.5, "dominanceScore": 0.698
            }
          ],
          "targets": [{ "userId": "@gdm_user_abc:synapse", "identityName": "Blue" }],
          "quietMembers": [{ "userId": "@gdm_user_def:synapse", "identityName": "Red" }],
          "message": "@Blue, you've brought a lot of energy to this — 72% of the airtime so far! Might be a good moment to hear from the others, too."
        }
      ],

      "rankingHistory": [
        {
          "taskId": "moon-survival",
          "order": ["oxygen", "water", "map", "…"],
          "updatedAt": "2026-07-13T10:20:00Z",
          "updatedBy": "@gdm_user_abc:synapse"
        }
      ],

      "behavioralEvents": [
        {
          "id": "evt-uuid",
          "type": "tab-hidden",
          "participantId": "@gdm_user_abc:synapse",
          "timestamp": "2026-07-13T10:12:00Z",
          "durationMs": 3000,
          "payload": {}
        }
      ],

      "contributionClassifications": [
        {
          "messageId": "msg-uuid",
          "senderId": "@gdm_user_abc:synapse",
          "classifiedAt": "2026-07-13T10:07:05Z",
          "relevance": { "rating": 5, "reason": "Names the oxygen tanks and takes a clear position." },
          "coherence": { "rating": 4, "reason": "Agrees with Red's oxygen proposal." },
          "invitesParticipation": { "value": false, "reason": "Does not address another member." },
          "meaningfulnessScore": 0.875,
          "model": "claude-haiku-4-5-20251001",
          "promptVersion": "meaningfulness-v2",
          "prompt": "…the exact prompt sent to the API…",
          "rawOutput": "…the raw JSON the model returned…"
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
| `typing-stop` | Participant stopped typing (carries `durationMs`) |
| `tab-hidden` | Browser tab left / participant switched away |
| `tab-visible` | Browser tab returned |
| `cursor-activity` | Mouse/cursor movement recorded |
| `ranking-move` | Participant dragged an item in the shared ranking |

---

## URL-only raw exports

### Overview (CSV): `overview.csv`

**Endpoint:** `GET /api/export/sessions.csv`

One row per session. Intended for a quick overview of study progress and session-level counts. Open directly in Excel or Numbers.

| Column | Description |
|---|---|
| `session_id` | Unique session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Human-readable condition name (e.g. "Baseline") |
| `round` | Study round the session was created in (1, 2, …) |
| `status` | `waiting`, `provisioning`, `running`, `completed`, or `aborted` |
| `participant_count` | Number of participants who joined |
| `message_count` | Total messages sent in the session (includes bot nudges, which are recorded in the chat log) |
| `reaction_count` | Total emoji reactions across all messages (always 0 since the reaction UI was removed per study protocol; kept for schema stability) |
| `ranking_edit_count` | Number of times the shared ranking was modified |
| `intervention_count` | Number of bot nudges fired |
| `created_at` | ISO 8601 timestamp, session created |
| `started_at` | ISO 8601 timestamp, chat room opened |
| `completed_at` | ISO 8601 timestamp, session ended |

### Detailed overview (CSV): `detailed_overview.csv`

**Endpoint:** `GET /api/export/sessions-detailed.csv`

One row per session with the **frozen condition snapshot** the session ran with — the file to consult when reconstructing which parameters applied in a given round. Columns: `session_id`, `status`, `round_id`, `condition_id`, `condition_name`, `goal`, `group_size`, `duration_minutes`, `llm_mode`, `workspace_mode`, `intervention_mode`, `invite_grace_seconds`, `protected_start_minutes`, `protected_end_minutes`, `contribution_threshold`, `contribution_window_minutes`, `score_weight_words`, `score_weight_messages`, `dominance_weight_share`, `dominance_weight_meaningfulness`, `final_group_ranking` (pipe-joined item ids), `room_id`, `created_at`, `started_at`, `completed_at`. Config keys missing from old snapshots are filled with the current defaults; legacy mode strings such as `public-engaging` are folded onto `baseline` / `public` / `private`.

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
      "conditionId": "baseline",
      "conditionName": "Baseline",
      "roundId": 1,
      "id": "msg-uuid",
      "timestamp": "2026-07-13T10:07:00Z",
      "senderId": "@gdm_user_abc:synapse",
      "recipientId": null,
      "text": "I'd put the oxygen tanks first — nothing else matters if we can't breathe.",
      "reactions": []
    }
  ]
}
```

> Bot messages are part of the chat log: `sender_id` is then the bot's Matrix id. `recipientId` is `null` for group messages; when set, the message is a private bot message rendered only to that participant (a private nudge, or a moderation warning if `MODERATION=on`). Bot messages never count toward contribution scores or shares.

**CSV columns**

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Condition name |
| `round` | Study round |
| `message_id` | Message identifier |
| `timestamp` | ISO 8601 send time |
| `sender_id` | Participant or bot Matrix id |
| `recipient_id` | Empty for group messages; participant Matrix id for private bot messages |
| `text` | Full message text |
| `reaction_count` | Number of reactions on this message |
| `reaction_keys` | Pipe-separated reaction keys, e.g. `👍\|❤️` |

---

### Nudge events

**Endpoints:** `GET /api/export/interventions` (JSON) · `GET /api/export/interventions.csv` (CSV)

One record per bot intervention across all sessions. (`GET /api/interventions` returns the newest interventions across all sessions without filters; it is an admin debugging aid, not an export.)

**JSON structure**
```json
{
  "generatedAt": "2026-07-13T10:00:00Z",
  "interventions": [
    {
      "id": "intervention-uuid",
      "sessionId": "session-uuid",
      "roomId": "!room-id:synapse",
      "conditionId": "public-llm",
      "conditionName": "Public × Rule+LLM",
      "roundId": 1,
      "timestamp": "2026-07-13T10:15:00Z",
      "mode": "public",
      "audience": "public",
      "trigger": "contribution-threshold",
      "threshold": 0.4,
      "llmMode": "active",
      "contributionWindowMinutes": 4,
      "contributionSplit": [
        {
          "userId": "@gdm_user_abc:synapse", "identityName": "Blue",
          "messageCount": 9, "wordCount": 140, "score": 16,
          "share": 0.72, "meaningfulnessScore": 0.5, "dominanceScore": 0.698
        }
      ],
      "targets": [{ "userId": "@gdm_user_abc:synapse", "identityName": "Blue" }],
      "quietMembers": [{ "userId": "@gdm_user_def:synapse", "identityName": "Red" }],
      "message": "@Blue, you've brought a lot of energy to this — 72% of the airtime so far! Might be a good moment to hear from the others, too."
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
| `round` | Study round |
| `timestamp` | ISO 8601 time the nudge was sent |
| `mode` | Delivery: `public` or `private` |
| `audience` | `public` or `private` |
| `trigger` | What caused the nudge (`contribution-threshold`) |
| `threshold` | Dominance-score threshold that was exceeded (0..1) |
| `llm_mode` | Detection mode that produced the nudge: `active` (composite score; both nudging arms). `off` only appears under the `LLM_MODE=off` override or in legacy data, since the baseline never fires a nudge |
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
      "conditionId": "baseline",
      "conditionName": "Baseline",
      "roundId": 1,
      "participantId": "participant-uuid",
      "participantName": "",
      "trackingToken": "prolific-token",
      "recruitmentSource": "prolific",
      "prolificPid": "…",
      "prolificStudyId": "…",
      "prolificSessionId": "…",
      "participantCompletedAt": "2026-07-13T10:36:30Z",
      "kind": "entry",
      "submittedAt": "2026-07-13T10:04:00Z",
      "answers": { "…": "see the answer keys below" }
    }
  ]
}
```

**Answer keys.** The keys are fixed by the participant survey components (`frontend/participant/src/components/`) and validated server-side (`backend/session-manager/src/validation/request-validation.ts`).

*Entry survey* (assembled from Consent, About You, Attitudes and Ranking Task pages):

| Key | Values | Source |
|---|---|---|
| `consentAdult`, `consentInformed`, `consentParticipation` | `true` | Consent page (all three boxes required) |
| `age` | 18–120 | About You; omitted when `agePreferNotToSay: true` |
| `agePreferNotToSay` | `true` | About You (only when ticked) |
| `gender` | `woman`, `man`, `nonbinary`, `self-describe`, `na` | About You |
| `genderCustom` | free text | About You (only when `self-describe`) |
| `education` | `high_school_or_less`, `some_college`, `vocational`, `bachelors`, `masters_or_higher`, `other`, `na` | About You |
| `educationOther` | free text | About You (only when `other`) |
| `englishProficiency` | `native_bilingual`, `fluent`, `intermediate`, `basic`, `none` | About You (`none` terminates the participant as ineligible; age < 18 likewise) |
| `gaais1` … `gaais10` | 1–5 | Attitudes: General Attitudes towards AI Scale items |
| `tipi1` … `tipi10` | 1–7 | Attitudes: Ten-Item Personality Inventory |
| `teamworkFrequency` | `never`, `rarely`, `sometimes`, `often`, `very_often` | Attitudes |
| `chatComfort` | 1–5 | Attitudes |
| `spaceflightFamiliarity`, `survivalFamiliarity` | 1–5 | Attitudes |
| `individualRanking` | array of the 10 item ids | Ranking Task |
| `rankingCompleted` | `true` / `false` (`false` = the 5-minute timer expired and the ranking was auto-completed in shown order) | Ranking Task |
| `rankingSecondsUsed` | 0–300 | Ranking Task |
| `groupInstructionsAcknowledged` | `true` | Group Intro page |

*Exit survey* (three steps: final individual ranking; task confidence + group dynamics; psychological safety + bot perception — the bot-perception block is shown in every arm, including the baseline):

| Key | Values | Meaning |
|---|---|---|
| `finalRanking` | array of the 10 item ids | The participant's individual re-ranking (starts from the group's final order) |
| `taskConfidence` | 1–5 | Confidence in the group ranking |
| `groupConsidered`, `groupBalanced`, `attentionCheck1`, `groupDominated`, `feltTeam`, `comfortableAgain` | 1–5 | Group-dynamics items; `attentionCheck1` asks for "disagree strongly" (= 1) |
| `safeSpeakUp`, `raiseConcerns`, `contradicted`, `attentionCheck2`, `contributionSerious`, `contributionInfluenced`, `heldBack` | 1–5 | Psychological-safety items; `attentionCheck2` asks for "agree moderately" (= 4) |
| `botIntrusive`, `botHelpful`, `botAppropriate`, `botObserved`, `botSupport` | 1–5 | Bot-perception items |
| `debriefFeedback` | free text (≤ 4000 chars) | Optional feedback typed on the Debriefing page; merged into the exit answers afterwards via `POST /api/surveys/debrief-feedback` |

Legacy keys still accepted by the validator and exported when present in old data, but never sent by the current forms: entry `topicFamiliarity` (1–7) and `fieldOfStudy`; exit `satisfaction`, `fairness`, `feltHeard` (1–7).

**CSV columns**

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `condition_name` | Condition name |
| `round` | Study round |
| `participant_id` | Participant identifier (internal UUID) |
| `participant_name` | Name sent at join time — always empty for real participants (the app sends none; the colour identities used in chat are derived client-side from room membership and are not stored) |
| `tracking_token` | Prolific or self-issued tracking token |
| `recruitment_source` | `direct` or `prolific` |
| `prolific_pid`, `prolific_study_id`, `prolific_session_id` | Prolific identity; empty for direct participants |
| `participant_completed_at` | ISO 8601 time the participant's exit survey was stored; empty otherwise |
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
      "conditionId": "public-llm",
      "roundId": 1,
      "participantId": "@gdm_user_abc:synapse",
      "messageCount": 12,
      "characterCount": 840,
      "reactionCount": 0,
      "rankingMoveCount": 3,
      "typingDurationMs": 42000,
      "relevanceMean": 3.8,
      "coherenceMean": 3.2,
      "invitesParticipationCount": 2,
      "meaningfulnessScoreMean": 0.625
    }
  ],

  "behavioralEvents": [
    {
      "sessionId": "session-uuid",
      "conditionId": "public-llm",
      "roundId": 1,
      "id": "evt-uuid",
      "type": "typing-start",
      "participantId": "@gdm_user_abc:synapse",
      "timestamp": "2026-07-13T10:07:00Z",
      "durationMs": 4200,
      "payload": {}
    }
  ],

  "classifications": [
    {
      "sessionId": "session-uuid",
      "conditionId": "public-llm",
      "roundId": 1,
      "messageId": "msg-uuid",
      "senderId": "@gdm_user_abc:synapse",
      "classifiedAt": "2026-07-13T10:07:05Z",
      "relevance": { "rating": 5, "reason": "Names the oxygen tanks and takes a clear position." },
      "coherence": { "rating": 4, "reason": "Agrees with Red's oxygen proposal." },
      "invitesParticipation": { "value": false, "reason": "Does not address another member." },
      "meaningfulnessScore": 0.875,
      "model": "claude-haiku-4-5-20251001",
      "promptVersion": "meaningfulness-v2",
      "prompt": "…the exact prompt sent to the API…",
      "rawOutput": "…the raw JSON the model returned…"
    }
  ]
}
```

> `participant_id`/`participantId` in this export is the **Matrix user id** (rows are collected from message and reaction senders, behavioral events and classifications), not the internal participant UUID used by the surveys and linkage exports — see the join caveat above. Participants with no recorded activity have no row; bot accounts never get a row.

**`contributions` fields**

| Field | Description |
|---|---|
| `messageCount` | Total messages sent by this participant |
| `characterCount` | Total characters across all messages |
| `reactionCount` | Total emoji reactions given by this participant (always 0 with the current UI) |
| `rankingMoveCount` | Number of times this participant moved an item in the shared ranking |
| `typingDurationMs` | Total milliseconds spent typing (from behavioral events) |
| `relevanceMean` | Mean `relevance.rating` (1..5) across this participant's classified messages; `null` when no message carries a rating (baseline, or records from the pre-v2 boolean classifier) |
| `coherenceMean` | Mean `coherence.rating` (1..5); `null` under the same conditions |
| `invitesParticipationCount` | Messages that explicitly invite another member to contribute |
| `meaningfulnessScoreMean` | Mean `meaningfulnessScore` across this participant's classified messages (0..1); `0` when nothing was classified (e.g. baseline) |

**`classifications` fields** (prompt version `meaningfulness-v2`)

| Field | Description |
|---|---|
| `relevance` | `{ rating, reason }` — integer 1–5: how much of the message contributes content relevant to the ranking task (naming items, stating stances, making proposals); 5 = fully task-focused, 1 = entirely off-topic |
| `coherence` | `{ rating, reason }` — integer 1–5: how well the message connects to and builds on the ongoing discussion; 5 = clearly addresses or extends prior messages or members, 1 = stands alone |
| `invitesParticipation` | `{ value, reason }` — explicitly invites another member to contribute. Tracked separately; never part of the meaningfulness score. |
| `meaningfulnessScore` | `(mean(relevance, coherence) − 1) / 4`, continuous in 0..1 |

Records written before this version (`promptVersion: "meaningfulness-v1"`)
carry three boolean indicators (`respondsToPrior`, `referencesTaskItem`,
`hasDiscussionStructure`) instead of the two ratings, and a `meaningfulnessScore`
that is the mean of those booleans. They still count toward
`meaningfulnessScoreMean` and `classified_message_count`, but are excluded from
`relevanceMean` / `coherenceMean`.

**CSV columns** (aggregate scores only; use the JSON export for behavioral events and per-message classifications)

| Column | Description |
|---|---|
| `session_id` | Session identifier |
| `condition_id` | Condition identifier |
| `round` | Study round |
| `participant_id` | Participant Matrix user id |
| `message_count` | Total messages sent |
| `character_count` | Total characters written |
| `reaction_count` | Total reactions given |
| `ranking_move_count` | Shared ranking edits made |
| `typing_duration_ms` | Total typing time in milliseconds |
| `relevance_mean` | Mean relevance rating (1..5) across classified messages; empty when none carries a rating |
| `coherence_mean` | Mean coherence rating (1..5); empty under the same conditions |
| `invites_participation_count` | Messages inviting another member to contribute |
| `meaningfulness_score_mean` | Mean meaningfulness score across classified messages (0..1) |

---

### Prolific lifecycle exports

**Endpoints:** `GET /api/export/prolific-arrivals` · `GET /api/export/prolific-outcomes`

JSON only, no filters, not session-based. `prolific-arrivals` returns every validated Prolific arrival (including people who left before claiming a seat) with `participantId`, `studyId`, `sessionId`, `arrivedAt`, `participantRecordId`, `stage`, `stageUpdatedAt`, `lastSeenAt` and — once terminal — `outcome`, `outcomeReason`, `endedAt`, `elapsedSeconds`, `compensationKind`, `compensationAmountPence`. `prolific-outcomes` returns `{ outcomes: [...] }` with the same fields plus `id`, `prolificActionStatus`, `returnRequestedAt`, `bonusBatchId`, `paymentSubmittedAt`, `actionError`. Both are identifying. See [prolific-integration.md](prolific-integration.md) for the lifecycle and compensation rules.

---

## Research exports (analysis-ready)

Available from the **Results tab → Research Exports** section. These are the files intended for statistical analysis: identifiers are **pseudonymous** (`P-xxxxxxxx` for participants, `S-xxxxxxxx` for sessions — the first 8 hex chars of SHA-256 over the internal UUID, stable across re-downloads), surveys and activity are pre-joined, and derived measures (ranking scores, participation equality) are computed server-side. Bot senders appear as `BOT`.

**One-click bundle:** `GET /api/export/research.zip` → `research_bundle.zip`, containing `participants.csv`, `sessions_analysis.csv`, `windows.csv`, `rankings.csv`, a pseudonymized `messages.csv` (`sender_is_bot`, `recipient_pseudonym` on private nudges), and `codebook.md` — a generated data dictionary with a study-rounds section, a full column table for `participants.csv`, prose descriptions of the other files, the NASA scoring rule and expert key, the equality metrics, and the window-outcome glossary. The linkage file is deliberately **not** in the bundle.

### Participants

**Endpoints:** `GET /api/export/participants` (JSON) · `GET /api/export/participants.csv`

One row per participant. Columns in order:

- Context: `participant_pseudonym`, `session_pseudonym`, `condition_id`, `condition_name`, `round`, `intervention_mode`, `llm_mode`, `session_status`, `group_size`, `recruitment_source`, `started_at`
- Entry survey: `entry_submitted`, `age`, `age_prefer_not_to_say`, `gender`, `gender_custom`, `education`, `education_other`, `field_of_study` (legacy), `english_proficiency`, `gaais1`–`gaais10`, `tipi1`–`tipi10`, `teamwork_frequency`, `chat_comfort`, `topic_familiarity` (legacy), `spaceflight_familiarity`, `survival_familiarity`, `individual_ranking_completed`, `individual_ranking_seconds_used`, `individual_ranking_error` (NASA error of the entry ranking; empty unless explicitly completed)
- Exit survey: `exit_submitted`, `exit_ranking_error` (NASA error of the exit re-ranking), `satisfaction`, `fairness`, `felt_heard` (legacy, empty for current data), `task_confidence`, `group_considered`, `group_balanced`, `attention_check_1`, `group_dominated`, `felt_team`, `comfortable_again`, `safe_speak_up`, `raise_concerns`, `contradicted`, `attention_check_2`, `contribution_serious`, `contribution_influenced`, `held_back`, `bot_intrusive`, `bot_helpful`, `bot_appropriate`, `bot_observed`, `bot_support`, `debrief_feedback`
- Chat activity: `message_count`, `word_count`, `character_count`, `contribution_share`
- Classifier aggregates: `meaningfulness_score_mean`, `classified_message_count` (empty / 0 in the baseline)
- Nudges received: `nudges_received_total`, `nudges_received_public`, `nudges_received_private`
- Behavioral aggregates: `typing_duration_ms`, `tab_hidden_count`, `ranking_move_count`

### Sessions (analysis)

**Endpoints:** `GET /api/export/sessions-analysis` (JSON) · `GET /api/export/sessions-analysis.csv` → `sessions_analysis.csv`

One row per session. Columns: `session_pseudonym`, `condition_id`, `condition_name`, `round`, `intervention_mode`, `llm_mode`, `status`, `n_participants`, `group_size`, `created_at`, `started_at`, `completed_at`, `planned_duration_minutes`, `group_ranking_error` (NASA score of the final shared ranking — read together with `ranking_edit_count`), `ranking_edit_count`, `participant_message_count`, `bot_message_count`, `word_count_total` (participant messages only — there is no bot word count), `share_std_dev`, `share_gini`, `intervention_count`, `interventions_public`, `interventions_private`, `windows_evaluated`, `windows_nudged`, `windows_no_target`, `windows_grace_suppressed`, `windows_baseline_suppressed` (the `warm-up` / `wrap-up` / `too-few-participants` outcomes have no count column), `classification_count`, `classification_failure_count`, `entry_surveys`, `exit_surveys`, `mean_satisfaction`, `mean_fairness`, `mean_felt_heard` (the three means are computed from the legacy exit keys and are empty for data collected with the current exit survey).

### Rankings (raw orders)

**Endpoints:** `GET /api/export/rankings` (JSON) · `GET /api/export/rankings.csv`

One row per ranking. Columns: `session_pseudonym`, `condition_id`, `round`, `type`, `participant_pseudonym`, `edit_index`, `timestamp`, `ranking_completed`, `error`, then one column per Moon Survival item in task order (`matches`, `food`, `parachute`, `heater`, `pistols`, `oxygen`, `map`, `raft`, `compass`, `firstaid`) holding the rank 1–10 assigned to that item. `type` is `entry` or `exit` (each participant's individual orders), `group-edit` (every shared-ranking state, ordered by `edit_index`, with the editing member's pseudonym — empty when the edit was recorded by `system`), or `group-final` (the session's final order, emitted for **every** session, including zero-edit ones). Entry rows that timed out carry `ranking_completed = false` and no error score (same policy as participants.csv), but the raw order is included.

### Contribution windows

**Endpoints:** `GET /api/export/windows` (JSON) · `GET /api/export/windows.csv`

The bot records **every** evaluated contribution-window boundary, not just fired nudges — including baseline sessions, where `baseline-suppressed` rows show when a nudge *would* have fired. The CSV is long format (one row per window × participant, ready for mixed-effects models; a window without a computed split — `warm-up`, `wrap-up`, `too-few-participants` — emits a single row with empty participant columns); the JSON nests the per-participant split inside each window record. CSV columns: `session_pseudonym`, `condition_id`, `round`, `intervention_mode`, `llm_mode`, `window_index`, `window_start`, `window_end`, `window_minutes`, `threshold` (the two frozen parameters), `outcome`, `max_dominance_score`, `intervention_fired`, `participant_pseudonym`, `message_count`, `word_count`, `score`, `share`, `meaningfulness_score`, `dominance_score`, `is_candidate_target`, `was_nudged`. Outcomes: `nudged`, `no-target`, `grace-suppressed`, `baseline-suppressed`, `warm-up`, `wrap-up`, `too-few-participants`. Only sessions run after this instrumentation was deployed have window records.

### Linkage (identifying — handle with care)

**Endpoint:** `GET /api/export/linkage.csv`

Columns: `participant_pseudonym`, `session_pseudonym`, `round`, `participant_id`, `session_id` (internal UUIDs), `tracking_token`, `recruitment_source`, `matrix_user_id`. Needed for compensation and exclusions only. Keep it out of analysis folders and never share it with the analysis dataset; it is excluded from the research bundle by design.

### Results summary (dashboard)

**Endpoint:** `GET /api/reports/summary`

Per-condition descriptives backing the Results tab: session counts by status, participant and entry/exit survey counts over all sessions in the filter, and — over completed sessions only — means for group ranking error, entry/exit individual ranking errors, satisfaction/fairness/felt-heard (legacy keys), share SD/Gini, nudges per session, plus the total number of nudges and the **sums** of windows evaluated and nudged. Accepts `conditionIds` and `roundIds`. Monitoring only — the CSVs are the citable record.

## Etherpad mode

See [Etherpad study mode](etherpad.md) for raw text exports, limits and capture semantics. Admin downloads include `etherpad.csv` when pad records are present; standalone JSON and CSV endpoints are available. Ranking-dependent scores are empty for these sessions, and Matrix chat exports remain unchanged.
