import type { Session } from "@gdm/shared";
import { toCsv } from "./csv";
import { pseudonymize } from "./pseudonym";

/**
 * linkage.csv: maps pseudonyms back to internal ids and tracking tokens.
 * Identifying — never part of a bundle.
 */
export function linkageCsv(sessions: Session[]): string {
  return toCsv([
    [
      "participant_pseudonym",
      "session_pseudonym",
      "round",
      "participant_id",
      "session_id",
      "tracking_token",
      "recruitment_source",
      "matrix_user_id",
    ],
    ...sessions.flatMap((session) =>
      session.participants.map((participant) => [
        pseudonymize("P", participant.id),
        pseudonymize("S", session.id),
        String(session.roundId),
        participant.id,
        session.id,
        participant.trackingToken,
        participant.recruitmentSource,
        participant.matrixUserId ?? "",
      ]),
    ),
  ]);
}
