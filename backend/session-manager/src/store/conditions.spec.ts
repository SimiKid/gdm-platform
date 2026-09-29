import { describe, expect, it } from "vitest";
import type { Condition } from "@gdm/shared";
import { normalizeCondition, seedConditions, sortConditions } from "./conditions";

describe("conditions", () => {
  it("clamps admin input to values a session can run with", () => {
    const [baseline] = seedConditions();
    const normalized = normalizeCondition({
      ...baseline,
      id: `  ${"x".repeat(200)} `,
      goal: Number.NaN,
      durationMinutes: 0,
      groupSize: 99,
      config: {
        ...baseline.config,
        interventionMode: "public-engaging" as Condition["config"]["interventionMode"],
        protectedStartMinutes: Number.NaN,
        contributionWindowMinutes: 0,
        contributionThreshold: 5,
      },
    });

    expect(normalized).toMatchObject({
      goal: 0,
      durationMinutes: 1,
      groupSize: 50,
      config: {
        interventionMode: "public",
        protectedStartMinutes: baseline.config.protectedStartMinutes,
        contributionWindowMinutes: 0.1,
        contributionThreshold: 1,
      },
    });
    expect(normalized.id).toHaveLength(128);
  });

  it("falls back to defaults for missing or unusable fractions", () => {
    const [baseline] = seedConditions();
    const normalized = normalizeCondition({
      ...baseline,
      config: {
        ...baseline.config,
        contributionWindowMinutes: Number.NaN,
        contributionThreshold: Number.NaN,
        workspaceMode: "etherpad",
      },
    });
    expect(normalized.config.workspaceMode).toBe("etherpad");
    expect(Number.isFinite(normalized.config.contributionWindowMinutes)).toBe(true);
    expect(Number.isFinite(normalized.config.contributionThreshold)).toBe(true);
  });

  it("orders seeded arms first, then other conditions by name", () => {
    const [baseline, publicArm, privateArm] = seedConditions();
    const custom = (id: string, name: string) => ({ ...baseline, id, name });
    const sorted = [
      custom("z", "Zulu"),
      privateArm,
      custom("a", "Alpha"),
      baseline,
      publicArm,
    ].sort(sortConditions);
    expect(sorted.map((condition) => condition.id)).toEqual([
      "baseline",
      "public-llm",
      "private-llm",
      "a",
      "z",
    ]);
  });
});
