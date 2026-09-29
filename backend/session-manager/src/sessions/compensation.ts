import type { ParticipationStage } from "@gdm/shared";

/** Partial payment: floor per minute and per payment, and the default cap. */
const PARTIAL_PAYMENT_MIN_PENCE = 10;
const DEFAULT_PARTIAL_PAYMENT_PENCE_PER_MINUTE = 10;
const DEFAULT_PARTIAL_PAYMENT_MAX_PENCE = 508;

/**
 * Partial payment for time spent since `startedAt`: started minutes times
 * `PARTIAL_PAYMENT_PENCE_PER_MINUTE`, capped at `PARTIAL_PAYMENT_MAX_PENCE`
 * and never below the per-payment floor.
 */
export function partialPaymentPence(startedAt: string, now = Date.now()): number {
  const elapsedSeconds = Math.max(
    1,
    Math.floor((now - Date.parse(startedAt)) / 1_000),
  );
  const pencePerMinute = Math.max(
    PARTIAL_PAYMENT_MIN_PENCE,
    Number(
      process.env.PARTIAL_PAYMENT_PENCE_PER_MINUTE ??
        DEFAULT_PARTIAL_PAYMENT_PENCE_PER_MINUTE,
    ) || DEFAULT_PARTIAL_PAYMENT_PENCE_PER_MINUTE,
  );
  const maximumPence = Math.max(
    PARTIAL_PAYMENT_MIN_PENCE,
    Number(
      process.env.PARTIAL_PAYMENT_MAX_PENCE ?? DEFAULT_PARTIAL_PAYMENT_MAX_PENCE,
    ) || DEFAULT_PARTIAL_PAYMENT_MAX_PENCE,
  );
  return Math.min(
    maximumPence,
    Math.max(
      PARTIAL_PAYMENT_MIN_PENCE,
      Math.ceil(elapsedSeconds / 60) * pencePerMinute,
    ),
  );
}

/**
 * Compensation of a participant whose heartbeat stopped: partial once they
 * reached the group phase, a manual review during the entry survey, else
 * nothing.
 */
export function disconnectCompensationKind(
  stage: ParticipationStage,
): "partial" | "manual_review" | "none" {
  return ["waiting", "chat", "exit"].includes(stage)
    ? "partial"
    : stage === "entry"
      ? "manual_review"
      : "none";
}

/**
 * Compensation of a self-reported ending: a withdrawal after the study
 * proper began is reviewed manually; consent/eligibility exits get nothing.
 */
export function selfTerminationCompensationKind(
  outcome: "declined_consent" | "ineligible" | "voluntary_withdrawal",
  stage: ParticipationStage,
): "manual_review" | "none" {
  return outcome === "voluntary_withdrawal" &&
    ["entry", "waiting", "chat", "exit"].includes(stage)
    ? "manual_review"
    : "none";
}
