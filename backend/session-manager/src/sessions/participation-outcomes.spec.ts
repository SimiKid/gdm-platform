import { describe, expect, it } from "vitest";
import type {
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  StudySettings,
} from "@gdm/shared";
import { defaultOutcomeReason, toOutcomeResponse } from "./participation-outcomes";

const settings: StudySettings = {
  compensationUrl: "https://done",
  noConsentUrl: "https://no-consent",
  ineligibleUrl: "https://ineligible",
  withdrawalUrl: "https://withdrawal",
  unmatchedUrl: "https://unmatched",
  technicalFailureUrl: "https://technical",
};

function record(
  outcome: ParticipationOutcome,
  compensationKind?: ParticipationOutcomeRecord["compensationKind"],
): ParticipationOutcomeRecord {
  return {
    id: "a1",
    participantId: "pid",
    studyId: "study",
    sessionId: "sub",
    arrivedAt: "2026-09-29T10:00:00.000Z",
    stage: "terminated",
    stageUpdatedAt: "2026-09-29T10:00:00.000Z",
    lastSeenAt: "2026-09-29T10:00:00.000Z",
    outcome,
    compensationKind,
  };
}

describe("participation outcomes", () => {
  it.each([
    ["declined_consent", "https://no-consent"],
    ["ineligible", "https://ineligible"],
    ["voluntary_withdrawal", "https://withdrawal"],
    ["connection_timeout", "https://technical"],
    ["unmatched", "https://unmatched"],
    ["technical_failure", "https://technical"],
    ["participant_dropout", "https://technical"],
    ["group_aborted", "https://technical"],
    ["completed", "https://done"],
  ] as const)("redirects %s to its configured page", (outcome, url) => {
    const response = toOutcomeResponse(record(outcome), settings);
    expect(response.outcome).toBe(outcome);
    expect(response.redirectUrl).toBe(url);
    expect(response.message).not.toBe("");
  });

  it("falls back when no technical-failure page is configured", () => {
    const fallback = { ...settings, technicalFailureUrl: "" };
    expect(toOutcomeResponse(record("connection_timeout"), fallback).redirectUrl).toBe(
      "https://withdrawal",
    );
    expect(toOutcomeResponse(record("group_aborted"), fallback).redirectUrl).toBe(
      "https://unmatched",
    );
  });

  it("words the message by compensation kind", () => {
    expect(toOutcomeResponse(record("voluntary_withdrawal", "manual_review"), settings).message)
      .toContain("review the time you spent");
    expect(toOutcomeResponse(record("connection_timeout", "partial"), settings).message)
      .toContain("partial payment");
    expect(toOutcomeResponse(record("connection_timeout", "none"), settings).message)
      .toContain("return instructions");
  });

  it("gives every self-reported ending a default reason", () => {
    expect(defaultOutcomeReason("declined_consent")).toContain("consent");
    expect(defaultOutcomeReason("ineligible")).toContain("eligibility");
    expect(defaultOutcomeReason("voluntary_withdrawal")).toContain("withdraw");
    expect(defaultOutcomeReason("connection_timeout")).toContain("reconnect");
    expect(defaultOutcomeReason("unmatched")).toContain("before full completion");
  });
});
