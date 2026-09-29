import {
  DEFAULT_INTERVENTION_CONFIG,
  MOON_SURVIVAL,
  MOON_SURVIVAL_EXPERT_RANKING,
} from "@gdm/shared";
import { rankingErrorScore } from "./scoring";

/** Codebook section appended when the bundle contains etherpad.csv. */
export const ETHERPAD_CODEBOOK = `

## Etherpad text tasks

This bundle includes etherpad.csv. Each row represents one private entry pad,
shared group pad, or private exit pad. Join the pseudonymous participant and
session IDs to the other files. Unmatched entry pads have no session ID.
raw_text is the final server-accepted plain text (maximum 1,000 Unicode code
points); CSV formula escaping follows the other text exports. The JSON Etherpad
download preserves the original text. state=captured with empty text means a
blank response; open/error means no final snapshot yet. revision, deadline and
captured_at describe the snapshot. Access grants are never exported.

Etherpad sessions do not have ranking orders, ranking error scores or ranking
edit counts. Those cells are empty and rankings.csv omits these sessions.
Chat transcripts, contribution measures and bot analysis still describe only
the Matrix conversation, not the Etherpad text. The entry and exit pads start
blank and private; group text is never copied into the exit task.
`;

/** codebook.md of the research bundle: study design, pseudonyms, every file's columns. */
export function codebook(generatedAt: string): string {
  const itemCount = MOON_SURVIVAL.items.length;
  const maximumError =
    rankingErrorScore(
      Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
        .sort(([, a], [, b]) => b - a)
        .map(([id]) => id),
    ) ?? 0;
  const expertKey = MOON_SURVIVAL.items
    .map(
      (item) =>
        `| ${item.id} | ${item.label} | ${MOON_SURVIVAL_EXPERT_RANKING[item.id]} |`,
    )
    .join("\n");
  return `# GDM Study — Research Data Codebook

Generated: ${generatedAt}

## 1. Study design

Group decision-making sessions on the NASA "Survival on the Moon" ranking
task. A turn-taking bot evaluates contribution dominance at the end of every
contribution window and may nudge the most dominant member. Arms differ only
in **delivery** (\`intervention_mode\`): \`baseline\` (bot never posts),
\`public\` (nudge visible to the whole group), \`private\` (nudge rendered
only to the target).

\`llm_mode\` records the detection used to score dominance: \`active\` in
both nudging arms (composite dominance = 0.90 × share + 0.10 × LLM-scored
meaningfulness) and \`off\` in the baseline (raw contribution share; the
classifier is not called). It is not a study axis.

All exports accept \`?conditionIds=a,b,c\` to restrict to specific arms and
\`?roundIds=1,2\` to restrict to specific study rounds. Sessions from
\`e2e-…\` test conditions are always excluded.

### Study rounds

The study runs in numbered rounds; every session is stamped with the round
open at its creation (the \`round\` column in every file) and never changes
rounds. Session & Bot Parameters may differ between rounds — each session's
frozen condition snapshot carries the values that actually applied, and
windows.csv rows carry their own \`window_minutes\` and \`threshold\`, so
per-round parameter changes are fully reconstructable from the data.

## 2. Pseudonymization

Sessions are \`S-xxxxxxxx\`, participants \`P-xxxxxxxx\` — the first 8 hex
chars of SHA-256 over the internal UUID (never the Prolific token). The same
entity has the same pseudonym in every file and every re-download.
Pseudonyms are not ordered; sort by \`started_at\`. Bot senders appear as
\`BOT\`.

The separate \`linkage.csv\` export (deliberately NOT in this bundle) maps
pseudonyms to Prolific tracking tokens and Matrix ids for compensation and
exclusions. Treat it as identifying data; keep it out of analysis folders.

## 3. Files

### participants.csv — one row per participant

| Column | Meaning |
| --- | --- |
| participant_pseudonym / session_pseudonym | Stable pseudonymous ids |
| condition_id / condition_name / intervention_mode / llm_mode | Arm, from the session's frozen condition snapshot |
| session_status | waiting / running / completed / aborted — filter on \`completed\` for analysis |
| group_size / started_at | Session context |
| recruitment_source | Server-recorded admission source: direct or prolific |
| entry_submitted / exit_submitted | \`true\` or empty (survey missing) |
| age, age_prefer_not_to_say | Participant age or \`true\` if they declined to answer |
| gender, gender_custom | Gender identity; gender_custom filled when "self-describe" selected |
| education, education_other | Highest education level; education_other filled when "other" selected |
| field_of_study | Legacy field (pre-v2 forms only, empty for newer submissions) |
| english_proficiency | English proficiency level (native_bilingual / fluent / intermediate) |
| gaais1–gaais10 | GAAIS AI attitude items (1=disagree strongly … 5=agree strongly) |
| tipi1–tipi10 | TIPI personality items (1=disagree strongly … 7=agree strongly) |
| teamwork_frequency | How often participant works in teams (never/rarely/sometimes/often/very_often) |
| chat_comfort | Text-chat comfort (1–5, legacy 1–7) |
| topic_familiarity | Legacy combined spaceflight/survival familiarity (1–7, older data only) |
| spaceflight_familiarity | Spaceflight topic familiarity (1–5) |
| survival_familiarity | Wilderness/survival topic familiarity (1–5) |
| individual_ranking_completed | \`false\` = the entry ranking timed out and was auto-completed in shown order |
| individual_ranking_seconds_used | Time spent on the individual ranking |
| individual_ranking_error | NASA error score of the entry ranking; empty unless completed = true |
| exit_ranking_error | NASA error score of the participant's final individual ranking (exit survey) |
| satisfaction, fairness, felt_heard | Legacy exit 1–7 scales (pre-v2 only) |
| task_confidence | Confidence in group ranking (1–5) |
| group_considered … comfortable_again | Group dynamics items (1–5, includes attention_check_1) |
| safe_speak_up … held_back | Psychological safety items (1–5, includes attention_check_2) |
| bot_intrusive … bot_support | Bot perception items (1–5). Asked in every arm, including the baseline (where the bot never posts), so the exit instrument is identical across arms |
| debrief_feedback | Free-text feedback from the debriefing page (optional) |
| message_count, word_count, character_count | This participant's chat activity (bot messages never count) |
| contribution_share | Share of the session's total contribution score (messages × ${DEFAULT_INTERVENTION_CONFIG.scoreWeights.messages} + words × ${DEFAULT_INTERVENTION_CONFIG.scoreWeights.words}, weights from the condition snapshot) |
| meaningfulness_score_mean / classified_message_count | LLM classifier aggregates (nudging arms only; empty in baseline). meaningfulness_score = (mean(relevance, coherence) − 1) / 4, each rated 1–5 by the classifier (prompt version meaningfulness-v2) |
| nudges_received_total / _public / _private | Bot nudges targeting this participant |
| typing_duration_ms, tab_hidden_count, ranking_move_count | Behavioral telemetry aggregates |

### sessions_analysis.csv — one row per session

Includes aborted/running sessions with their \`status\`; compute descriptives
over \`status = completed\`. \`group_ranking_error\` is defined even with
zero edits (the shuffled starting order) — read with \`ranking_edit_count\`.
\`share_std_dev\` (SD of contribution shares; 0 = equal) and \`share_gini\`
(Gini of contribution scores; 0 = equal) are the participation-equality
outcomes. Window outcome counts (\`windows_*\`) summarize windows.csv.
\`classification_failure_count\` reports LLM coverage gaps (failed API
calls); messages that failed classification are absent from meaningfulness
means rather than counted as 0.

### windows.csv — one row per evaluated window × participant (long format)

Every contribution-window boundary produces exactly one evaluation.
\`outcome\` glossary:

- \`nudged\` — a nudge fired (\`intervention_fired\` = true; \`was_nudged\`
  marks the targeted participant)
- \`no-target\` — nobody crossed the threshold
- \`baseline-suppressed\` — baseline arm: a member crossed the threshold but
  nothing was delivered (counterfactual)
- \`warm-up\` / \`wrap-up\` / \`too-few-participants\` — boundary not
  evaluated; participant columns empty

The contribution tracker resets after each fired nudge, so scores reflect
activity since the last nudge (or warm-up end), not cumulative history.
The participant columns are the bot's own split: in the nudging arms
(\`llm_mode\` = active), messages classified as inviting others to
participate are excluded from \`message_count\`, \`word_count\`, \`score\`,
\`share\` and \`meaningfulness_score\`; in the baseline every message counts.
\`invitation_count\` is the number of messages excluded this way (always 0
in the baseline, which has no classifier; empty for windows recorded before
the exclusion was introduced).
Windows exist only for sessions run after this instrumentation was deployed.

### rankings.csv — one row per ranking (raw orders)

The raw material behind every error score, for item-level analyses (which
items are systematically misplaced, convergence toward the expert
solution). \`type\`:

- \`entry\` — the participant's individual ranking before the discussion
  (\`ranking_completed\` = false means it timed out and was auto-completed
  in shown order; such rows carry no \`error\`)
- \`exit\` — the participant's fresh individual ranking after the discussion
- \`group-edit\` — one state of the shared group ranking; \`edit_index\`
  orders the history (0 = first recorded state) and
  \`participant_pseudonym\` is the member who produced it
- \`group-final\` — the group's final order at session end

The ${itemCount} item columns hold the rank (1..${itemCount}) assigned to that item in this
row's order; compare against the expert key below.

### messages.csv — one row per chat message

Pseudonymized senders; \`sender_is_bot\` = true for nudges;
\`recipient_pseudonym\` set only on private nudges. Message text is
participant-authored free text.

## 4. Ranking scoring

NASA error score = Σ over items of |assigned rank − expert rank|
(0 = perfect, ${maximumError} = fully reversed). Expert key:

| Item id | Label | Expert rank |
| --- | --- | --- |
${expertKey}

## 5. Known caveats

- Bot messages appear in messages.csv (and in the legacy overview
  message_count) but never count toward contribution scores or shares.
- Emoji reactions were removed from the chat UI per study protocol; reaction
  counts are always 0.
- Historical sessions run before window instrumentation have no windows.csv
  rows and no classification-failure accounting.
- Entry rankings that timed out (\`individual_ranking_completed\` = false)
  are auto-completed permutations; they are not scored.
`;
}
