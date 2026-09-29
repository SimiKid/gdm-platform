import type {
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationOutcomeResponse,
  StudySettings,
} from "@gdm/shared";

/**
 * Participant-facing texts and redirects of a terminal Prolific outcome.
 */

/** What the participant is shown, and where they are sent, for an outcome. */
export function toOutcomeResponse(
  record: ParticipationOutcomeRecord,
  settings: StudySettings,
): ParticipationOutcomeResponse {
  const outcome = record.outcome!;
  const redirectUrl = outcomeUrl(settings, outcome);
  return {
    outcome,
    compensationKind: record.compensationKind,
    compensationAmountPence: record.compensationAmountPence,
    redirectUrl,
    message: outcomeMessage(record),
  };
}

/** Stored reason of a self-reported ending that came without one. */
export function defaultOutcomeReason(outcome: ParticipationOutcome): string {
  switch (outcome) {
    case "declined_consent":
      return "The participant did not consent to take part.";
    case "ineligible":
      return "The participant did not meet the study eligibility requirements.";
    case "voluntary_withdrawal":
      return "The participant chose to withdraw from the study.";
    case "connection_timeout":
      return "The participant did not reconnect within the allowed grace period.";
    default:
      return "The participation ended before full completion.";
  }
}

function outcomeUrl(
  settings: StudySettings,
  outcome: ParticipationOutcome,
): string {
  switch (outcome) {
    case "declined_consent":
      return settings.noConsentUrl;
    case "ineligible":
      return settings.ineligibleUrl;
    case "voluntary_withdrawal":
      return settings.withdrawalUrl;
    case "connection_timeout":
      return settings.technicalFailureUrl || settings.withdrawalUrl;
    case "unmatched":
      return settings.unmatchedUrl;
    case "technical_failure":
    case "participant_dropout":
    case "group_aborted":
      return settings.technicalFailureUrl || settings.unmatchedUrl;
    case "completed":
      return settings.compensationUrl;
  }
}

function outcomeMessage(record: ParticipationOutcomeRecord): string {
  switch (record.outcome) {
    case "declined_consent":
      return "You have not entered the study. Please return your submission on Prolific.";
    case "ineligible":
      return "You cannot continue with this study. Please follow the return instructions.";
    case "voluntary_withdrawal":
      return record.compensationKind === "manual_review"
        ? "Your withdrawal was recorded. The researcher will review the time you spent."
        : "Your withdrawal was recorded. Please return your submission on Prolific.";
    case "connection_timeout":
      return record.compensationKind === "partial"
        ? "Your connection was lost and the reconnect window expired. Your partial payment has been queued for review."
        : "Your connection was lost and the reconnect window expired. Please follow the Prolific return instructions.";
    case "unmatched":
      return "A complete group could not be formed. Your partial payment has been queued for review.";
    case "technical_failure":
    case "group_aborted":
      return "The study could not continue. Your partial payment has been queued for review.";
    case "participant_dropout":
      return "Your participation ended before the group task finished. The researcher will review compensation.";
    case "completed":
      return "Your participation is complete.";
    default:
      return "Your participation has ended.";
  }
}
