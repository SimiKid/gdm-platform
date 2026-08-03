import { describe, expect, it } from "vitest";
import { MOON_SURVIVAL, MOON_SURVIVAL_EXPERT_RANKING } from "@gdm/shared";
import { rankingErrorScore } from "./scoring";

const EXPERT_ORDER = Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
  .sort(([, a], [, b]) => a - b)
  .map(([id]) => id);

describe("rankingErrorScore", () => {
  it("scores the expert order as 0", () => {
    expect(rankingErrorScore(EXPERT_ORDER)).toBe(0);
  });

  it("scores the fully reversed order as 112 (max for 15 items)", () => {
    expect(rankingErrorScore([...EXPERT_ORDER].reverse())).toBe(112);
  });

  it("covers every task item exactly once", () => {
    expect(Object.keys(MOON_SURVIVAL_EXPERT_RANKING).sort()).toEqual(
      MOON_SURVIVAL.items.map((item) => item.id).sort(),
    );
    expect(new Set(Object.values(MOON_SURVIVAL_EXPERT_RANKING)).size).toBe(15);
  });

  it("scores a single swap by its rank distance", () => {
    const order = [...EXPERT_ORDER];
    // Swap ranks 1 and 3: |1-3| + |3-1| = 4.
    [order[0], order[2]] = [order[2], order[0]];
    expect(rankingErrorScore(order)).toBe(4);
  });

  it("returns null for missing, partial, duplicated, or unknown rankings", () => {
    expect(rankingErrorScore(undefined)).toBeNull();
    expect(rankingErrorScore(EXPERT_ORDER.slice(0, 10))).toBeNull();
    expect(
      rankingErrorScore([EXPERT_ORDER[0], ...EXPERT_ORDER.slice(0, 14)]),
    ).toBeNull();
    expect(
      rankingErrorScore(["definitely-not-an-item", ...EXPERT_ORDER.slice(1)]),
    ).toBeNull();
  });
});
