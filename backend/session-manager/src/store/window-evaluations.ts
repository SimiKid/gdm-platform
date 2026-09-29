import type { WindowEvaluation } from "@gdm/shared";

/**
 * One record per window boundary. Chat-service builds before 2026-09-20 could
 * evaluate a boundary twice when its timer fired a few milliseconds early:
 * after a nudge the second pass saw the tracker reset and recorded an
 * all-zero "no-target" copy, otherwise an identical one. Those copies carry
 * their own random ids, so the id-keyed merge keeps them — this drops them on
 * every read and merge, leaving the stored rows untouched.
 *
 * Per boundary (`windowEnd`) the kept record is the nudged one, else the one
 * that counted the most messages, else the first. Order of first occurrence
 * is preserved.
 */
export function dedupeWindowEvaluations(
  evaluations: WindowEvaluation[],
): WindowEvaluation[] {
  const kept = new Map<string, WindowEvaluation>();
  for (const evaluation of evaluations) {
    const current = kept.get(evaluation.windowEnd);
    if (!current || outranks(evaluation, current)) {
      kept.set(evaluation.windowEnd, evaluation);
    }
  }
  return [...kept.values()];
}

function outranks(candidate: WindowEvaluation, current: WindowEvaluation): boolean {
  if (Boolean(candidate.interventionId) !== Boolean(current.interventionId)) {
    return Boolean(candidate.interventionId);
  }
  return messageTotal(candidate) > messageTotal(current);
}

function messageTotal(evaluation: WindowEvaluation): number {
  return evaluation.contributionSplit.reduce(
    (sum, share) => sum + share.messageCount,
    0,
  );
}
