import { countWords } from "@gdm/shared";
import type { Participant, Session } from "@gdm/shared";
import { toCsv } from "./csv";
import { contributionScores, meanMeaningfulnessScore } from "./equality";
import { pseudonymize } from "./pseudonym";
import {
  BOT_PERCEPTION_KEYS,
  GROUP_DYNAMICS_KEYS,
  PSYCH_SAFETY_KEYS,
  cell,
  interventionModeOf,
  isEtherpad,
  llmModeOf,
  rankingAnswer,
  round,
  roundOrNull,
  scalarAnswer,
} from "./report-values";
import { rankingErrorScore } from "./scoring";

export type ParticipantRow = ReturnType<typeof participantRow>;

/** participants.csv: one row per participant (surveys, activity, nudges). */
export function participantsCsv(participants: ParticipantRow[]): string {
  return toCsv([
    [
      "participant_pseudonym",
      "session_pseudonym",
      "condition_id",
      "condition_name",
      "round",
      "intervention_mode",
      "llm_mode",
      "session_status",
      "group_size",
      "recruitment_source",
      "started_at",
      "entry_submitted",
      "age",
      "age_prefer_not_to_say",
      "gender",
      "gender_custom",
      "education",
      "education_other",
      "field_of_study",
      "english_proficiency",
      "gaais1",
      "gaais2",
      "gaais3",
      "gaais4",
      "gaais5",
      "gaais6",
      "gaais7",
      "gaais8",
      "gaais9",
      "gaais10",
      "tipi1",
      "tipi2",
      "tipi3",
      "tipi4",
      "tipi5",
      "tipi6",
      "tipi7",
      "tipi8",
      "tipi9",
      "tipi10",
      "teamwork_frequency",
      "chat_comfort",
      "topic_familiarity",
      "spaceflight_familiarity",
      "survival_familiarity",
      "individual_ranking_completed",
      "individual_ranking_seconds_used",
      "individual_ranking_error",
      "exit_submitted",
      "exit_ranking_error",
      "satisfaction",
      "fairness",
      "felt_heard",
      "task_confidence",
      "group_considered",
      "group_balanced",
      "attention_check_1",
      "group_dominated",
      "felt_team",
      "comfortable_again",
      "safe_speak_up",
      "raise_concerns",
      "contradicted",
      "attention_check_2",
      "contribution_serious",
      "contribution_influenced",
      "held_back",
      "bot_intrusive",
      "bot_helpful",
      "bot_appropriate",
      "bot_observed",
      "bot_support",
      "debrief_feedback",
      "message_count",
      "word_count",
      "character_count",
      "contribution_share",
      "meaningfulness_score_mean",
      "classified_message_count",
      "nudges_received_total",
      "nudges_received_public",
      "nudges_received_private",
      "typing_duration_ms",
      "tab_hidden_count",
      "ranking_move_count",
    ],
    ...participants.map((row) => [
      row.participantPseudonym,
      row.sessionPseudonym,
      row.conditionId,
      row.conditionName,
      String(row.round),
      row.interventionMode,
      row.llmMode,
      row.sessionStatus,
      String(row.groupSize),
      row.recruitmentSource,
      row.startedAt ?? "",
      cell(row.entrySubmitted),
      cell(row.age),
      cell(row.agePreferNotToSay),
      cell(row.gender),
      cell(row.genderCustom),
      cell(row.education),
      cell(row.educationOther),
      cell(row.fieldOfStudy),
      cell(row.englishProficiency),
      ...row.gaais.map(cell),
      ...row.tipi.map(cell),
      cell(row.teamworkFrequency),
      cell(row.chatComfort),
      cell(row.topicFamiliarity),
      cell(row.spaceflightFamiliarity),
      cell(row.survivalFamiliarity),
      cell(row.individualRankingCompleted),
      cell(row.individualRankingSecondsUsed),
      cell(row.individualRankingError),
      cell(row.exitSubmitted),
      cell(row.exitRankingError),
      cell(row.satisfaction),
      cell(row.fairness),
      cell(row.feltHeard),
      cell(row.taskConfidence),
      ...row.groupDynamics.map(cell),
      ...row.psychSafety.map(cell),
      ...row.botPerception.map(cell),
      cell(row.debriefFeedback),
      String(row.messageCount),
      String(row.wordCount),
      String(row.characterCount),
      cell(row.contributionShare),
      cell(row.meaningfulnessScoreMean),
      String(row.classifiedMessageCount),
      String(row.nudgesReceivedTotal),
      String(row.nudgesReceivedPublic),
      String(row.nudgesReceivedPrivate),
      String(row.typingDurationMs),
      String(row.tabHiddenCount),
      cell(row.rankingMoveCount),
    ]),
  ]);
}

export function participantRow(session: Session, participant: Participant) {
  const entry = participant.entrySurvey;
  const exit = participant.exitSurvey;
  const matrixUserId = participant.matrixUserId;
  const messages = session.chat.messages.filter(
    (message) =>
      matrixUserId !== undefined && message.senderId === matrixUserId,
  );
  const wordCount = messages.reduce(
    (sum, message) => sum + countWords(message.text),
    0,
  );
  const scores = contributionScores(session);
  const total = scores.reduce((sum, score) => sum + score, 0);
  const index = session.participants.indexOf(participant);
  const contributionShare =
    total > 0 && index >= 0 ? round(scores[index] / total) : null;
  const classifications = session.contributionClassifications.filter(
    (item) => matrixUserId !== undefined && item.senderId === matrixUserId,
  );
  const nudges = session.interventions.filter(
    (intervention) =>
      matrixUserId !== undefined &&
      intervention.targets.some((target) => target.userId === matrixUserId),
  );
  const behavior = (type: string) =>
    session.behavioralEvents.filter(
      (event) =>
        matrixUserId !== undefined &&
        event.participantId === matrixUserId &&
        event.type === type,
    );
  const rankingCompleted = isEtherpad(session) ? null : scalarAnswer(entry, "rankingCompleted");

  return {
    participantPseudonym: pseudonymize("P", participant.id),
    sessionPseudonym: pseudonymize("S", session.id),
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    round: session.roundId,
    interventionMode: interventionModeOf(session),
    llmMode: llmModeOf(session),
    sessionStatus: session.status,
    groupSize: session.condition.groupSize,
    recruitmentSource: participant.recruitmentSource,
    startedAt: session.startedAt ?? null,
    entrySubmitted: entry ? true : null,
    age: scalarAnswer(entry, "age"),
    agePreferNotToSay: scalarAnswer(entry, "agePreferNotToSay"),
    gender: scalarAnswer(entry, "gender"),
    genderCustom: scalarAnswer(entry, "genderCustom"),
    education: scalarAnswer(entry, "education"),
    educationOther: scalarAnswer(entry, "educationOther"),
    fieldOfStudy: scalarAnswer(entry, "fieldOfStudy"),
    englishProficiency: scalarAnswer(entry, "englishProficiency"),
    gaais: Array.from({ length: 10 }, (_, i) =>
      scalarAnswer(entry, `gaais${i + 1}`),
    ),
    tipi: Array.from({ length: 10 }, (_, i) =>
      scalarAnswer(entry, `tipi${i + 1}`),
    ),
    teamworkFrequency: scalarAnswer(entry, "teamworkFrequency"),
    chatComfort: scalarAnswer(entry, "chatComfort"),
    topicFamiliarity: scalarAnswer(entry, "topicFamiliarity"),
    spaceflightFamiliarity: scalarAnswer(entry, "spaceflightFamiliarity"),
    survivalFamiliarity: scalarAnswer(entry, "survivalFamiliarity"),
    individualRankingCompleted: rankingCompleted,
    individualRankingSecondsUsed: isEtherpad(session) ? null : scalarAnswer(entry, "rankingSecondsUsed"),
    // Timed-out entry rankings are auto-completed in shown order, so only
    // rankings the participant explicitly finished are scored.
    individualRankingError:
      rankingCompleted === true
        ? rankingErrorScore(rankingAnswer(entry, "individualRanking"))
        : null,
    exitSubmitted: exit ? true : null,
    exitRankingError: isEtherpad(session) ? null : rankingErrorScore(rankingAnswer(exit, "finalRanking")),
    satisfaction: scalarAnswer(exit, "satisfaction"),
    fairness: scalarAnswer(exit, "fairness"),
    feltHeard: scalarAnswer(exit, "feltHeard"),
    taskConfidence: scalarAnswer(exit, "taskConfidence"),
    groupDynamics: GROUP_DYNAMICS_KEYS.map((key) => scalarAnswer(exit, key)),
    psychSafety: PSYCH_SAFETY_KEYS.map((key) => scalarAnswer(exit, key)),
    botPerception: BOT_PERCEPTION_KEYS.map((key) => scalarAnswer(exit, key)),
    debriefFeedback: scalarAnswer(exit, "debriefFeedback"),
    messageCount: messages.length,
    wordCount,
    characterCount: messages.reduce(
      (sum, message) => sum + message.text.length,
      0,
    ),
    contributionShare,
    meaningfulnessScoreMean: roundOrNull(meanMeaningfulnessScore(classifications)),
    classifiedMessageCount: classifications.length,
    nudgesReceivedTotal: nudges.length,
    nudgesReceivedPublic: nudges.filter((n) => n.audience === "public").length,
    nudgesReceivedPrivate: nudges.filter((n) => n.audience === "private").length,
    typingDurationMs: behavior("typing-stop").reduce(
      (sum, event) => sum + (event.durationMs ?? 0),
      0,
    ),
    tabHiddenCount: behavior("tab-hidden").length,
    rankingMoveCount: isEtherpad(session) ? null : behavior("ranking-move").length,
  };
}
