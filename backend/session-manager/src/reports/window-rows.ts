import type { Session, WindowEvaluation } from "@gdm/shared";
import { toCsv } from "./csv";
import { pseudonymize, senderPseudonym } from "./pseudonym";
import { cell, interventionModeOf } from "./report-values";

/** Every evaluated contribution window with the bot's per-participant split. */
export function windowRows(sessions: Session[]) {
  return sessions.flatMap((session) =>
    // Explicit shape: research files carry pseudonyms, not Matrix ids.
    (session.windowEvaluations ?? []).map((evaluation) => ({
      sessionPseudonym: pseudonymize("S", session.id),
      conditionId: evaluation.conditionId,
      round: session.roundId,
      interventionMode: interventionModeOf(session),
      llmMode: evaluation.llmMode,
      windowIndex: evaluation.windowIndex,
      windowStart: evaluation.windowStart,
      windowEnd: evaluation.windowEnd,
      contributionWindowMinutes: evaluation.contributionWindowMinutes,
      threshold: evaluation.threshold,
      outcome: evaluation.outcome,
      maxDominanceScore: evaluation.maxDominanceScore,
      interventionFired: evaluation.outcome === "nudged",
      contributionSplit: evaluation.contributionSplit.map((share) => ({
        participantPseudonym: senderPseudonym(session, share.userId),
        messageCount: share.messageCount,
        wordCount: share.wordCount,
        invitationCount: share.invitationCount ?? null,
        score: share.score,
        share: share.share,
        meaningfulnessScore: share.meaningfulnessScore,
        dominanceScore: share.dominanceScore,
        isCandidateTarget: evaluation.candidateTargets.some(
          (target) => target.userId === share.userId,
        ),
        wasNudged: wasNudged(session, evaluation, share.userId),
      })),
    })),
  );
}

/**
 * Long format: one row per window × participant, loadable straight into
 * mixed-effects models. Windows with no computed split (warm-up, wrap-up,
 * too few participants) emit one row with the participant columns empty so
 * every evaluated boundary stays visible.
 */
export function windowsCsv(sessions: Session[]): string {
  const rows: string[][] = [];
  for (const session of sessions) {
    for (const evaluation of session.windowEvaluations ?? []) {
      const windowCells = [
        pseudonymize("S", session.id),
        session.condition.id,
        String(session.roundId),
        interventionModeOf(session),
        evaluation.llmMode,
        String(evaluation.windowIndex),
        evaluation.windowStart,
        evaluation.windowEnd,
        String(evaluation.contributionWindowMinutes),
        String(evaluation.threshold),
        evaluation.outcome,
        cell(evaluation.maxDominanceScore),
        evaluation.outcome === "nudged" ? "true" : "false",
      ];
      if (evaluation.contributionSplit.length === 0) {
        rows.push([...windowCells, "", "", "", "", "", "", "", "", "", ""]);
        continue;
      }
      for (const share of evaluation.contributionSplit) {
        rows.push([
          ...windowCells,
          senderPseudonym(session, share.userId),
          String(share.messageCount),
          String(share.wordCount),
          cell(share.invitationCount),
          String(share.score),
          String(share.share),
          String(share.meaningfulnessScore),
          String(share.dominanceScore),
          evaluation.candidateTargets.some(
            (target) => target.userId === share.userId,
          )
            ? "true"
            : "false",
          wasNudged(session, evaluation, share.userId) ? "true" : "false",
        ]);
      }
    }
  }
  return toCsv([
    [
      "session_pseudonym",
      "condition_id",
      "round",
      "intervention_mode",
      "llm_mode",
      "window_index",
      "window_start",
      "window_end",
      "window_minutes",
      "threshold",
      "outcome",
      "max_dominance_score",
      "intervention_fired",
      "participant_pseudonym",
      "message_count",
      "word_count",
      "invitation_count",
      "score",
      "share",
      "meaningfulness_score",
      "dominance_score",
      "is_candidate_target",
      "was_nudged",
    ],
    ...rows,
  ]);
}

function wasNudged(
  session: Session,
  evaluation: WindowEvaluation,
  userId: string,
): boolean {
  if (!evaluation.interventionId) return false;
  const intervention = session.interventions.find(
    (item) => item.id === evaluation.interventionId,
  );
  return intervention?.targets.some((target) => target.userId === userId) ?? false;
}
