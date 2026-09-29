import { describe, expect, it } from "vitest";
import type { Session } from "@gdm/shared";
import {
  filterResearchPads,
  filterResearchSessions,
  researchFilter,
} from "./filter";

function session(id: string, conditionId: string, workspaceMode = "etherpad"): Session {
  return {
    id,
    roundId: 1,
    condition: { id: conditionId, config: { workspaceMode } },
  } as unknown as Session;
}

describe("research filter", () => {
  it("parses the query axes, dropping blanks and invalid round numbers", () => {
    expect(researchFilter(" a, b ,,", "1, x, 0, 2")).toEqual({
      conditionIds: ["a", "b"],
      roundIds: [1, 2],
    });
    expect(researchFilter()).toEqual({ conditionIds: [], roundIds: [] });
  });

  it("always drops E2E test conditions", () => {
    const sessions = [session("s1", "baseline"), session("s2", "e2e-run")];
    expect(filterResearchSessions(sessions).map((s) => s.id)).toEqual(["s1"]);
  });

  it("keeps pads of the filtered Etherpad sessions and unmatched pads only unfiltered", () => {
    const sessions = [session("s1", "baseline"), session("s2", "baseline", "ranking")];
    const pads = [
      { id: "group", sessionId: "s1" },
      { id: "ranking-session", sessionId: "s2" },
      { id: "other", sessionId: "s9" },
      { id: "unmatched" },
    ];
    expect(filterResearchPads(pads, sessions).map((pad) => pad.id)).toEqual([
      "group",
      "unmatched",
    ]);
    expect(
      filterResearchPads(pads, sessions, { roundIds: [1] }).map((pad) => pad.id),
    ).toEqual(["group"]);
  });
});
