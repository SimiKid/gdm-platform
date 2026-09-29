import { countWords, isServiceUser } from "@gdm/shared";
import type { Session, Survey } from "@gdm/shared";
import { toCsv } from "./csv";
import { contributionScores, gini, meanOf, shareStdDev } from "./equality";
import { pseudonymize } from "./pseudonym";
import {
  cell,
  interventionModeOf,
  isEtherpad,
  llmModeOf,
  roundOrNull,
  scalarAnswer,
} from "./report-values";
import { rankingErrorScore } from "./scoring";

export type SessionAnalysisRow = ReturnType<typeof sessionRow>;

/** sessions_analysis.csv: one row per session (outcomes, equality, windows). */
export function sessionsAnalysisCsv(sessions: SessionAnalysisRow[]): string {
  return toCsv([
    [
      "session_pseudonym",
      "condition_id",
      "condition_name",
      "round",
      "intervention_mode",
      "llm_mode",
      "status",
      "n_participants",
      "group_size",
      "created_at",
      "started_at",
      "completed_at",
      "planned_duration_minutes",
      "group_ranking_error",
      "ranking_edit_count",
      "participant_message_count",
      "bot_message_count",
      "word_count_total",
      "share_std_dev",
      "share_gini",
      "intervention_count",
      "interventions_public",
      "interventions_private",
      "windows_evaluated",
      "windows_nudged",
      "windows_no_target",
      "windows_baseline_suppressed",
      "classification_count",
      "classification_failure_count",
      "entry_surveys",
      "exit_surveys",
      "mean_satisfaction",
      "mean_fairness",
      "mean_felt_heard",
    ],
    ...sessions.map((row) => [
      row.sessionPseudonym,
      row.conditionId,
      row.conditionName,
      String(row.round),
      row.interventionMode,
      row.llmMode,
      row.status,
      String(row.nParticipants),
      String(row.groupSize),
      row.createdAt,
      row.startedAt ?? "",
      row.completedAt ?? "",
      String(row.plannedDurationMinutes),
      cell(row.groupRankingError),
      cell(row.rankingEditCount),
      String(row.participantMessageCount),
      String(row.botMessageCount),
      String(row.wordCountTotal),
      cell(row.shareStdDev),
      cell(row.shareGini),
      String(row.interventionCount),
      String(row.interventionsPublic),
      String(row.interventionsPrivate),
      String(row.windowsEvaluated),
      String(row.windowsNudged),
      String(row.windowsNoTarget),
      String(row.windowsBaselineSuppressed),
      String(row.classificationCount),
      String(row.classificationFailureCount),
      String(row.entrySurveys),
      String(row.exitSurveys),
      cell(row.meanSatisfaction),
      cell(row.meanFairness),
      cell(row.meanFeltHeard),
    ]),
  ]);
}

export function sessionRow(session: Session) {
  const participantMessages = session.chat.messages.filter(
    (message) => !isServiceUser(message.senderId),
  );
  const scores = contributionScores(session);
  const windows = session.windowEvaluations ?? [];
  const exitSurveys = session.participants
    .map((participant) => participant.exitSurvey)
    .filter((survey): survey is Survey => survey !== undefined);
  const exitScale = (key: string) =>
    meanOf(
      exitSurveys.map((survey) => {
        const value = scalarAnswer(survey, key);
        return typeof value === "number" ? value : null;
      }),
    );

  return {
    sessionPseudonym: pseudonymize("S", session.id),
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    round: session.roundId,
    interventionMode: interventionModeOf(session),
    llmMode: llmModeOf(session),
    status: session.status,
    nParticipants: session.participants.length,
    groupSize: session.condition.groupSize,
    createdAt: session.createdAt,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    plannedDurationMinutes: session.durationMinutes,
    // Computable even with zero edits (the shuffled starting order) — always
    // read together with rankingEditCount.
    groupRankingError: isEtherpad(session) ? null : rankingErrorScore(session.ranking.order),
    rankingEditCount: isEtherpad(session) ? null : session.rankingHistory?.length ?? 0,
    participantMessageCount: participantMessages.length,
    botMessageCount:
      session.chat.messages.length - participantMessages.length,
    wordCountTotal: participantMessages.reduce(
      (sum, message) => sum + countWords(message.text),
      0,
    ),
    shareStdDev: roundOrNull(shareStdDev(scores)),
    shareGini: roundOrNull(gini(scores)),
    interventionCount: session.interventions.length,
    interventionsPublic: session.interventions.filter(
      (item) => item.audience === "public",
    ).length,
    interventionsPrivate: session.interventions.filter(
      (item) => item.audience === "private",
    ).length,
    windowsEvaluated: windows.length,
    windowsNudged: windows.filter((w) => w.outcome === "nudged").length,
    windowsNoTarget: windows.filter((w) => w.outcome === "no-target").length,
    windowsBaselineSuppressed: windows.filter(
      (w) => w.outcome === "baseline-suppressed",
    ).length,
    classificationCount: session.contributionClassifications.length,
    classificationFailureCount: (session.classificationFailures ?? []).length,
    entrySurveys: session.participants.filter((p) => p.entrySurvey).length,
    exitSurveys: exitSurveys.length,
    meanSatisfaction: roundOrNull(exitScale("satisfaction")),
    meanFairness: roundOrNull(exitScale("fairness")),
    meanFeltHeard: roundOrNull(exitScale("feltHeard")),
  };
}
