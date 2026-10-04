import { PARTICIPATION_STAGES } from "@gdm/shared";
import type {
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationStage,
  ProlificArrival,
  ProlificIdentity,
} from "@gdm/shared";
import { json } from "./prisma-values";

/**
 * Pure rules of the Prolific participation journey shared by the database
 * and in-memory paths of ParticipationStore.
 */

export const STAGE_ORDER: readonly ParticipationStage[] = PARTICIPATION_STAGES;

/** Stored length limit of a free-text termination reason. */
const OUTCOME_REASON_MAX_LENGTH = 500;

export type TerminationCompensation = "none" | "partial" | "manual_review";

/** One terminal Prolific outcome as both termination paths persist it. */
export interface Termination {
  outcome: Exclude<ParticipationOutcome, "completed">;
  reason: string;
  compensationKind: TerminationCompensation;
  compensationAmountPence?: number;
}

/** In-memory key (and outcome id) of one Prolific submission. */
export function arrivalKey(identity: ProlificIdentity): string {
  return `${identity.studyId}:${identity.sessionId}`;
}

function elapsedSecondsSince(start: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1_000));
}

/** Arrival-row fields of a terminal outcome. */
export function terminationData(now: Date, arrivedAt: Date, termination: Termination) {
  return {
    stage: "terminated",
    stageUpdatedAt: now,
    lastSeenAt: now,
    outcome: termination.outcome,
    outcomeReason: termination.reason.slice(0, OUTCOME_REASON_MAX_LENGTH),
    endedAt: now,
    elapsedSeconds: elapsedSecondsSince(arrivedAt, now),
    compensationKind: termination.compensationKind,
    compensationAmountPence: termination.compensationAmountPence,
  };
}

/** Audit event recorded with a terminal outcome. */
export function terminatedEvent(termination: Termination) {
  return {
    type: "terminated",
    stage: "terminated",
    detail: json({
      outcome: termination.outcome,
      reason: termination.reason.slice(0, OUTCOME_REASON_MAX_LENGTH),
    }),
  };
}

/** Compensation row queued for the Prolific action worker. */
export function pendingCompensation(now: Date, termination: Termination) {
  return {
    kind: termination.compensationKind,
    amountPence: termination.compensationAmountPence,
    status: "pending",
    nextAttemptAt: now,
  };
}

/** In-memory equivalent of the DB termination (same truncation rules). */
export function terminateMemoryArrival(
  identity: ProlificIdentity,
  arrival: ProlificArrival,
  now: Date,
  termination: Termination,
): ParticipationOutcomeRecord {
  const data = terminationData(now, new Date(arrival.arrivedAt), termination);
  Object.assign(arrival, {
    ...data,
    stage: "terminated",
    stageUpdatedAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    endedAt: now.toISOString(),
    prolificActionStatus: "pending",
  });
  return { id: arrivalKey(identity), ...arrival };
}
