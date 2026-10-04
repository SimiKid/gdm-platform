import { countWords, isServiceUser } from "@gdm/shared";
import type { InterventionLog, Session } from "@gdm/shared";
import { toCsv } from "./csv";
import { pseudonymize, senderPseudonym } from "./pseudonym";

/** messages.csv of the research bundle: pseudonymized senders and recipients. */
export function researchMessagesCsv(sessions: Session[]): string {
  return toCsv([
    [
      "session_pseudonym",
      "condition_id",
      "round",
      "message_id",
      "timestamp",
      "sender_pseudonym",
      "sender_is_bot",
      "recipient_pseudonym",
      "text",
      "word_count",
    ],
    ...sessions.flatMap((session) =>
      session.chat.messages.map((message) => [
        pseudonymize("S", session.id),
        session.condition.id,
        String(session.roundId),
        message.id,
        message.timestamp,
        senderPseudonym(session, message.senderId),
        isServiceUser(message.senderId) ? "true" : "false",
        message.recipientId
          ? senderPseudonym(session, message.recipientId)
          : "",
        message.text,
        String(countWords(message.text)),
      ]),
    ),
  ]);
}

/**
 * messages.csv of the research-data zip: one row per chat message.
 * `group_id` repeats `session_id` (a session is one group); both columns
 * stay for schema stability of results.csv joins.
 */
export function messagesFlatCsv(sessions: Session[]): string {
  return toCsv([
    [
      "session_id",
      "group_id",
      "condition",
      "round",
      "message_id",
      "timestamp",
      "member_id",
      "sender_is_bot",
      "intervention_id",
      "text",
      "word_count",
    ],
    ...sessions.flatMap((session) => {
      const memberIndex = new Map<string, number>();
      session.participants.forEach((p, i) => {
        if (p.matrixUserId) memberIndex.set(p.matrixUserId, i + 1);
      });
      const interventionByMessage = interventionIdsByMessage(session);
      return session.chat.messages.map((message) => {
        const isBotMsg = isServiceUser(message.senderId);
        const memberId = isBotMsg
          ? ""
          : String(memberIndex.get(message.senderId) ?? "");
        const interventionId = isBotMsg
          ? interventionByMessage.get(message.id) ?? ""
          : "";
        return [
          session.id,
          session.id,
          session.condition.name,
          String(session.roundId),
          message.id,
          message.timestamp,
          memberId,
          isBotMsg ? "true" : "false",
          interventionId,
          message.text,
          String(countWords(message.text)),
        ];
      });
    }),
  ]);
}

/**
 * Bot message id → id of the intervention it delivered.
 *
 * InterventionLog carries no id of the Matrix message that delivered the
 * nudge (the Chat Service records only its text), so the link is rebuilt
 * from the text: the n-th bot message with a given text belongs to the n-th
 * intervention with that text (preferring one with the same audience and,
 * for a private nudge, the same recipient). Pairing by occurrence keeps repeated fallback
 * templates apart instead of attributing them all to one intervention.
 */
function interventionIdsByMessage(session: Session): Map<string, string> {
  const byText = new Map<string, InterventionLog[]>();
  const interventions = [...session.interventions].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  for (const intervention of interventions) {
    const queue = byText.get(intervention.message) ?? [];
    queue.push(intervention);
    byText.set(intervention.message, queue);
  }
  const matched = new Map<string, string>();
  for (const message of session.chat.messages) {
    if (!isServiceUser(message.senderId)) continue;
    const queue = byText.get(message.text);
    if (!queue?.length) continue;
    const sameAudience = queue.findIndex((intervention) =>
      message.recipientId
        ? intervention.audience === "private" &&
          intervention.targets.some((target) => target.userId === message.recipientId)
        : intervention.audience !== "private",
    );
    const [intervention] = queue.splice(Math.max(0, sameAudience), 1);
    matched.set(message.id, intervention.id);
  }
  return matched;
}
