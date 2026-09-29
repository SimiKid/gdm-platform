import { describe, expect, it } from "vitest";
import type { WindowEvaluation } from "@gdm/shared";
import { dedupeWindowEvaluations } from "./window-evaluations";

function evaluation(
  id: string,
  windowEnd: string,
  messageCounts: number[],
  overrides: Partial<WindowEvaluation> = {},
): WindowEvaluation {
  return {
    id,
    sessionId: "s1",
    conditionId: "public-llm",
    windowIndex: 0,
    windowStart: "2026-07-31T08:30:54.000Z",
    windowEnd,
    contributionWindowMinutes: 1,
    llmMode: "active",
    threshold: 0.4,
    outcome: "no-target",
    contributionSplit: messageCounts.map((messageCount, index) => ({
      userId: `@u${index}:test`,
      identityName: `Member${index}`,
      messageCount,
      wordCount: messageCount * 5,
      score: messageCount,
      share: 0,
      meaningfulnessScore: 0,
      dominanceScore: 0,
    })),
    candidateTargets: [],
    maxDominanceScore: null,
    interventionId: null,
    ...overrides,
  };
}

const END_0 = "2026-07-31T08:31:54.000Z";
const END_1 = "2026-07-31T08:32:54.000Z";

describe("dedupeWindowEvaluations", () => {
  it("keeps the nudged record over the all-zero copy of the same boundary, in either order", () => {
    const nudged = evaluation("real", END_0, [1, 3, 2], { outcome: "nudged", interventionId: "n1" });
    const zeroCopy = evaluation("copy", END_0, [0, 0, 0]);
    expect(dedupeWindowEvaluations([nudged, zeroCopy])).toEqual([nudged]);
    expect(dedupeWindowEvaluations([zeroCopy, nudged])).toEqual([nudged]);
  });

  it("prefers the record that counted messages when neither nudged", () => {
    const counted = evaluation("counted", END_0, [2, 1]);
    const empty = evaluation("empty", END_0, [0, 0]);
    expect(dedupeWindowEvaluations([empty, counted])).toEqual([counted]);
  });

  it("keeps the first of identical copies", () => {
    const first = evaluation("first", END_0, [0, 0]);
    const second = evaluation("second", END_0, [0, 0]);
    expect(dedupeWindowEvaluations([first, second])).toEqual([first]);
  });

  it("keeps every distinct boundary in order of first occurrence", () => {
    const a = evaluation("a", END_1, [1, 1], { windowIndex: 1 });
    const b = evaluation("b", END_0, [2, 0], { outcome: "nudged", interventionId: "n1" });
    const bCopy = evaluation("b-copy", END_0, [0, 0]);
    const warmUp = evaluation("warm", "2026-07-31T08:30:54.000Z", [], { outcome: "warm-up" });
    expect(dedupeWindowEvaluations([a, bCopy, warmUp, b])).toEqual([a, b, warmUp]);
  });

  it("returns an empty list unchanged", () => {
    expect(dedupeWindowEvaluations([])).toEqual([]);
  });
});
