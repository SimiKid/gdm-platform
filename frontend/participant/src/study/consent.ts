/**
 * The declaration-of-consent checkboxes. Keys double as the entry-survey
 * answer keys, so the boxes shown and the flags persisted stay in sync.
 * The backend rejects an entry survey where any of them is present but not
 * `true` (see request-validation.ts).
 */
export const CONSENT_ITEMS = [
  { key: "consentAdult", text: "I am at least 18 years old." },
  {
    key: "consentInformed",
    text:
      "I have read and understood the information above, including that my " +
      "pseudonymized chat messages will be sent to Anthropic's API for " +
      "processing, depending on the study group I am assigned to.",
  },
  {
    key: "consentWithdrawal",
    text: "I understand I can withdraw at any time without consequence.",
  },
  { key: "consentParticipation", text: "I voluntarily consent to participate." },
] as const;
