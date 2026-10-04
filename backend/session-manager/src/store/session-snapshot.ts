import type { Prisma } from "@prisma/client";
import type { Session, Survey } from "@gdm/shared";
import { checkpointFromSession } from "./checkpoint-merge";
import { json, toDate } from "./prisma-values";
import {
  participantCreateData,
  participantUpdateData,
  sessionCreateData,
  sessionUpdateData,
} from "./row-mappers";
import { persistRuntimeCheckpoint } from "./runtime-checkpoint";

/**
 * Write a whole session aggregate inside one transaction: the session row,
 * its participants and surveys, then its runtime state through the same
 * monotonic merge a Chat Service checkpoint uses.
 */
export async function persistSessionSnapshot(
  tx: Prisma.TransactionClient,
  session: Session,
): Promise<void> {
  await tx.sessionRecord.upsert({
    where: { id: session.id },
    create: sessionCreateData(session),
    update: sessionUpdateData(session),
  });

  for (const participant of session.participants) {
    await tx.participantRecord.upsert({
      where: { id: participant.id },
      create: participantCreateData(session.id, participant),
      update: participantUpdateData(session.id, participant),
    });
    if (participant.entrySurvey) {
      await upsertSurvey(tx, participant.id, "entry", participant.entrySurvey);
    }
    if (participant.exitSurvey) {
      await upsertSurvey(tx, participant.id, "exit", participant.exitSurvey);
    }
  }

  await persistRuntimeCheckpoint(
    tx,
    session.id,
    checkpointFromSession(session),
  );
}

/** Store one participant's entry or exit survey, replacing an earlier one. */
export async function upsertSurvey(
  db: Prisma.TransactionClient,
  participantId: string,
  kind: "entry" | "exit",
  survey: Survey,
): Promise<void> {
  await db.surveyRecord.upsert({
    where: { participantId_kind: { participantId, kind } },
    create: {
      participantId,
      kind,
      answers: json(survey.answers),
      submittedAt: toDate(survey.submittedAt),
    },
    update: {
      answers: json(survey.answers),
      submittedAt: toDate(survey.submittedAt),
    },
  });
}
