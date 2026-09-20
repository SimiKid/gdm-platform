import { describe, expect, it } from "vitest";
import type { Session } from "@gdm/shared";
import {
  classifierSummary,
  engagementSummary,
  formatClock,
  formatCount,
  formatShare,
  formatSharePoints,
  nudgeComparisons,
  participantIdentities,
  sessionTimeline,
} from "./session-detail";
import { session } from "./test-utils";

const T0 = Date.parse("2026-09-01T10:00:00.000Z");

describe("participantIdentities", () => {
  it("assigns chat colours by sorted Matrix id and appends unprovisioned people in grey", () => {
    const s = session();
    s.participants.push({
      id: "p4",
      name: "",
      trackingToken: "tok-pending-rest",
      recruitmentSource: "direct",
    });
    const ids = participantIdentities(s);
    expect(ids.map((i) => [i.userId, i.name])).toEqual([
      ["@a:localhost", "Red"],
      ["@b:localhost", "Blue"],
      ["@c:localhost", "Green"],
      [null, "tok-pend"],
    ]);
    expect(ids[0].color).toBe("#e03131");
    expect(ids[3].color).toBe("#868e96");
  });
});

describe("sessionTimeline", () => {
  it("is null before the chat starts", () => {
    expect(sessionTimeline(session({ startedAt: undefined, status: "waiting" }))).toBeNull();
  });

  it("derives phases, evaluated windows, suppressed windows and message ticks", () => {
    const t = sessionTimeline(session())!;
    expect(t.start).toBe(T0);
    expect(t.end).toBe(T0 + 10 * 60_000);
    expect(t.live).toBe(false);
    expect(t.warmUpEnd).toBe(T0 + 60_000);
    expect(t.wrapUpStart).toBe(T0 + 9 * 60_000);
    expect(t.windowMs).toBe(2 * 60_000);
    expect(t.threshold).toBe(0.4);
    // The wrap-up boundary carries no split and is not a drawable window.
    expect(t.windows.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(t.windows[0].shares.get("@a:localhost")?.share).toBe(0.67);
    expect(t.suppressed).toEqual([]);
    expect(t.nudges).toHaveLength(1);
    expect(t.nudges[0]).toMatchObject({ id: "n1", audience: "public", targetNames: ["Red"] });
    // Bot messages never become participant ticks.
    expect(t.messageTicks).toHaveLength(6);
    expect(t.messageTicks.every((tick) => tick.userId !== "@gdm_bot:localhost")).toBe(true);
  });

  it("runs the axis to the planned end while the session is live", () => {
    const t = sessionTimeline(session({ status: "running", completedAt: undefined }))!;
    expect(t.live).toBe(true);
    expect(t.end).toBe(T0 + 10 * 60_000);
  });

  it("extends a short session to its last evaluated window", () => {
    const t = sessionTimeline(session({ completedAt: "2026-09-01T10:04:00.000Z" }))!;
    expect(t.end).toBe(Date.parse("2026-09-01T10:09:00.000Z"));
  });

  it("collects baseline counterfactual windows as suppressed", () => {
    const s = session();
    s.windowEvaluations![1].outcome = "baseline-suppressed";
    s.windowEvaluations![1].candidateTargets = [{ userId: "@b:localhost", identityName: "Blue" }];
    const t = sessionTimeline(s)!;
    expect(t.suppressed.map((w) => w.index)).toEqual([1]);
    expect(t.suppressed[0].candidateTargets[0].identityName).toBe("Blue");
  });
});

describe("nudgeComparisons", () => {
  it("compares the triggering window with the next evaluated window", () => {
    const [c] = nudgeComparisons(session());
    expect(c.windowIndex).toBe(0);
    expect(c.activeBefore).toBe(2);
    expect(c.activeAfter).toBe(3);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({
      name: "Red",
      role: "target",
      before: { share: 0.67, messageCount: 2 },
      after: { share: 0.34, messageCount: 1 },
      deltaMessages: -1,
    });
    expect(c.rows[0].deltaShare).toBeCloseTo(-0.33);
    expect(c.rows[1]).toMatchObject({
      name: "Green",
      role: "quiet",
      before: { share: 0, messageCount: 0 },
      after: { share: 0.33, messageCount: 1 },
      deltaMessages: 1,
    });
  });

  it("links by timestamp when the window record carries no intervention id", () => {
    const s = session();
    s.windowEvaluations![0].interventionId = null;
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBe(0);
    expect(c.rows[0].after).not.toBeNull();
  });

  it("reports no later window when the nudge fell in the last evaluated window", () => {
    const s = session();
    s.windowEvaluations = s.windowEvaluations!.filter((w) => w.windowIndex === 0);
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBe(0);
    expect(c.activeAfter).toBeNull();
    expect(c.rows[0]).toMatchObject({ after: null, deltaShare: null, deltaMessages: null });
  });

  it("still shows the before split when no window records exist at all", () => {
    const s = session({ windowEvaluations: [] });
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBeNull();
    expect(c.rows[0].before).toEqual({ share: 0.67, messageCount: 2, dominanceScore: 0.67 });
    expect(c.rows[0].after).toBeNull();
  });
});

describe("classifierSummary", () => {
  it("reports coverage and the mean score when the classifier ran", () => {
    expect(classifierSummary(session())).toEqual({
      mode: "active",
      classified: 2,
      failed: 1,
      participantMessages: 6,
      meanMeaningfulness: 0.5,
    });
  });

  it("reports off for the baseline arm and for sessions without any classification data", () => {
    const s = session({ interventions: [], windowEvaluations: [], contributionClassifications: [] });
    s.condition = { ...s.condition, config: { ...s.condition.config, llmMode: "off" } };
    expect(classifierSummary(s)).toEqual({ mode: "off" });
  });

  it("prefers the mode recorded on the windows over the condition config", () => {
    const s = session({ contributionClassifications: [] });
    s.condition = { ...s.condition, config: { ...s.condition.config, llmMode: "off" } };
    expect(classifierSummary(s)).toMatchObject({ mode: "active", classified: 0, meanMeaningfulness: null });
  });
});

describe("engagementSummary", () => {
  it("sums messages, typing time, tab switches and ranking moves per participant", () => {
    const e = engagementSummary(session());
    expect(e.botMessages).toBe(1);
    expect(e.perUser.get("@a:localhost")).toEqual({
      messages: 3,
      typingMs: 5000,
      tabHidden: 0,
      rankingMoves: 2,
    });
    expect(e.perUser.get("@c:localhost")).toEqual({
      messages: 1,
      typingMs: 0,
      tabHidden: 1,
      rankingMoves: 0,
    });
    expect(e.totals).toEqual({ messages: 6, typingMs: 8000, tabHidden: 1, rankingMoves: 2 });
  });
});

describe("formatters", () => {
  it("format clocks, shares and signed deltas", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_400)).toBe("1:05");
    expect(formatShare(0.666)).toBe("67%");
    expect(formatSharePoints(0.12)).toBe("+12 pp");
    expect(formatSharePoints(-0.084)).toBe("−8 pp");
    expect(formatSharePoints(0.001)).toBe("±0 pp");
    expect(formatCount(3)).toBe("+3");
    expect(formatCount(-2)).toBe("−2");
    expect(formatCount(0)).toBe("±0");
  });
});

// Type-level guard: the builder must produce a complete Session.
const _typed: Session = session();
void _typed;
