import { createHash } from "node:crypto";
import { isServiceUser } from "@gdm/shared";
import type { Session } from "@gdm/shared";

/**
 * Deterministic pseudonym for a session or participant: `S-`/`P-` plus the
 * first 8 hex chars of sha256 over the internal UUID.
 *
 * Hash-based (rather than ordinal S001…) so pseudonyms stay stable across
 * re-downloads while new sessions arrive, work identically in the in-memory
 * fallback store, and join consistently across every research file. The
 * input is the internal UUID — never the Prolific token — so a pseudonym
 * cannot be brute-forced back to a Prolific ID. Tradeoff: not
 * human-orderable; sort by `started_at` instead (documented in the codebook).
 */
export function pseudonymize(prefix: "S" | "P", id: string): string {
  return `${prefix}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}

/** Research-file label for a message/event sender within a session. */
export function senderPseudonym(session: Session, senderId: string): string {
  const participant = session.participants.find(
    (p) => p.id === senderId || p.matrixUserId === senderId,
  );
  if (participant) return pseudonymize("P", participant.id);
  if (isServiceUser(senderId)) return botKindLabel(senderId);
  // Unknown sender (e.g. a participant whose creds mapping was lost): still
  // pseudonymize deterministically rather than leaking the raw Matrix id.
  return pseudonymize("P", senderId);
}

/** "BOT" for the primary bot, "BOT-A"/"BOT-B" for the comparison arms. */
export function botKindLabel(userId: string): string {
  if (/_bot_a_/i.test(userId)) return "BOT-A";
  if (/_bot_b_/i.test(userId)) return "BOT-B";
  return "BOT";
}
