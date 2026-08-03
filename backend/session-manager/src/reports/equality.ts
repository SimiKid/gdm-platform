import { DEFAULT_INTERVENTION_CONFIG, isServiceUser } from "@gdm/shared";
import type { Session } from "@gdm/shared";

/**
 * Participation-equality metrics over a whole session, computed from the
 * same contribution score the bot uses (messages × weight + words × weight,
 * weights from the session's condition snapshot) — but over ALL participant
 * messages, not a single window. Bot messages never count.
 */

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Per-participant contribution scores, ordered like session.participants. */
export function contributionScores(session: Session): number[] {
  const weights =
    session.condition.config.scoreWeights ??
    DEFAULT_INTERVENTION_CONFIG.scoreWeights;
  return session.participants.map((participant) => {
    const messages = session.chat.messages.filter(
      (message) =>
        !isServiceUser(message.senderId) &&
        message.senderId === participant.matrixUserId,
    );
    const wordCount = messages.reduce(
      (sum, message) => sum + countWords(message.text),
      0,
    );
    return messages.length * weights.messages + wordCount * weights.words;
  });
}

/**
 * Population standard deviation of the normalized shares (score / total).
 * 0 = perfectly equal participation. Null when fewer than 2 participants or
 * nobody contributed anything.
 */
export function shareStdDev(scores: number[]): number | null {
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (scores.length < 2 || total <= 0) return null;
  const shares = scores.map((score) => score / total);
  const mean = 1 / scores.length;
  const variance =
    shares.reduce((sum, share) => sum + (share - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

/**
 * Gini coefficient of the contribution scores (standard pairwise formula).
 * 0 = perfectly equal; approaches (n−1)/n when one member does everything.
 * Null when fewer than 2 participants or nobody contributed anything.
 */
export function gini(scores: number[]): number | null {
  const total = scores.reduce((sum, score) => sum + score, 0);
  const n = scores.length;
  if (n < 2 || total <= 0) return null;
  let pairwise = 0;
  for (const a of scores) {
    for (const b of scores) pairwise += Math.abs(a - b);
  }
  return pairwise / (2 * n * total);
}

/** Mean of the non-null values, or null when there are none. */
export function meanOf(values: Array<number | null | undefined>): number | null {
  const present = values.filter((value): value is number => value != null);
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}
