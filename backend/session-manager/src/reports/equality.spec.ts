import { describe, expect, it } from "vitest";
import type { Session } from "@gdm/shared";
import {
  contributionScores,
  countWords,
  gini,
  meanOf,
  shareStdDev,
} from "./equality";

describe("shareStdDev", () => {
  it("is 0 for perfectly equal contributions", () => {
    expect(shareStdDev([2, 2, 2])).toBe(0);
  });

  it("matches the known value for a one-speaker session", () => {
    // Shares [1, 0, 0], mean 1/3 → sd = sqrt(2/9).
    expect(shareStdDev([5, 0, 0])).toBeCloseTo(Math.sqrt(2 / 9));
  });

  it("is null for fewer than 2 participants or an all-zero total", () => {
    expect(shareStdDev([3])).toBeNull();
    expect(shareStdDev([0, 0, 0])).toBeNull();
    expect(shareStdDev([])).toBeNull();
  });
});

describe("gini", () => {
  it("is 0 for perfectly equal contributions", () => {
    expect(gini([2, 2, 2])).toBe(0);
  });

  it("approaches (n-1)/n when one member does everything", () => {
    expect(gini([5, 0, 0])).toBeCloseTo(2 / 3);
  });

  it("is null for fewer than 2 participants or an all-zero total", () => {
    expect(gini([3])).toBeNull();
    expect(gini([0, 0])).toBeNull();
  });
});

describe("meanOf", () => {
  it("averages non-null values only", () => {
    expect(meanOf([2, null, 4, undefined])).toBe(3);
    expect(meanOf([null, undefined])).toBeNull();
  });
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  hello   there world ")).toBe(3);
    expect(countWords("")).toBe(0);
  });
});

describe("contributionScores", () => {
  it("scores participant messages with the snapshot weights, ignoring bots", () => {
    const session = {
      condition: {
        config: { scoreWeights: { messages: 1, words: 0.05 } },
      },
      participants: [
        { id: "p1", matrixUserId: "@gdm_u1:hs" },
        { id: "p2", matrixUserId: "@gdm_u2:hs" },
        { id: "p3" }, // never got Matrix creds
      ],
      chat: {
        messages: [
          { senderId: "@gdm_u1:hs", text: "one two three four" }, // 1 + 0.2
          { senderId: "@gdm_u1:hs", text: "five six" }, // 1 + 0.1
          { senderId: "@gdm_u2:hs", text: "seven" }, // 1 + 0.05
          { senderId: "@gdm_bot:hs", text: "a bot nudge never counts" },
        ],
      },
    } as unknown as Session;

    expect(contributionScores(session)).toEqual([2.3, 1.05, 0]);
  });
});
