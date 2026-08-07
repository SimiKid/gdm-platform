import { describe, expect, it } from "vitest";
import { MOON_SURVIVAL } from "@gdm/shared";
import {
  validateCompensationUrl,
  validateOpenSessionRequest,
  validateSurveyAnswers,
  validateSurveyRequest,
} from "./request-validation";

describe("request validation", () => {
  it("accepts the existing generic admission shape and bounds identifiers", () => {
    expect(() =>
      validateOpenSessionRequest({
        trackingToken: crypto.randomUUID(),
        participantName: "",
        conditionId: "public-rule",
      }),
    ).not.toThrow();
    expect(() =>
      validateOpenSessionRequest({
        trackingToken: "x".repeat(257),
        participantName: "",
      }),
    ).toThrow("trackingToken");
  });

  it("rejects invalid timestamps and deeply oversized survey data", () => {
    expect(() =>
      validateSurveyRequest({
        sessionId: "s",
        participantId: "p",
        kind: "entry",
        survey: { submittedAt: "not-a-date", answers: {} },
      }),
    ).toThrow("valid timestamp");
    expect(() =>
      validateSurveyRequest({
        sessionId: "s",
        participantId: "p",
        kind: "entry",
        survey: {
          submittedAt: "2026-08-07T12:00:00.000Z",
          answers: { value: "x".repeat(4_001) },
        },
      }),
    ).toThrow("oversized string");
  });

  it("accepts an exact ranking and rejects duplicate task items", () => {
    const expected = MOON_SURVIVAL.items.map((item) => item.id);
    const request = {
      sessionId: "s",
      participantId: "p",
      kind: "exit" as const,
      survey: {
        submittedAt: "2026-08-07T12:00:00.000Z",
        answers: {
          finalRanking: expected,
          satisfaction: 7,
          fairness: 6,
          feltHeard: 5,
        },
      },
    };
    expect(() => validateSurveyAnswers(request, expected)).not.toThrow();
    request.survey.answers.finalRanking = [expected[0], ...expected.slice(0, -1)];
    expect(() => validateSurveyAnswers(request, expected)).toThrow(
      "every task item exactly once",
    );
  });

  it("requires HTTPS compensation links except on local development hosts", () => {
    expect(validateCompensationUrl(" https://app.prolific.com/done ")).toBe(
      "https://app.prolific.com/done",
    );
    expect(validateCompensationUrl("http://localhost:3000/done")).toBe(
      "http://localhost:3000/done",
    );
    expect(() => validateCompensationUrl("http://example.com/done")).toThrow(
      "must use HTTPS",
    );
  });
});
