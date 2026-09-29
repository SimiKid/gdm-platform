import { describe, expect, it } from "vitest";
import type { Session } from "@gdm/shared";
import {
  classifierSummary,
  engagementSummary,
  formatClock,
  formatShare,
  nudgeComparisons,
  participantIdentities,
  sessionTimeline,
  spreadLabels,
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
    expect(c.basis).toBe("window");
    expect(c.afterUntil).toBeNull();
    expect(c.activeBefore).toBe(2);
    expect(c.activeAfter).toBe(3);
    expect(c.rows.map((r) => [r.name, r.role])).toEqual([
      ["Red", "target"],
      ["Blue", "unaddressed"],
      ["Green", "quiet"],
    ]);
    expect(c.rows[0]).toMatchObject({
      name: "Red",
      role: "target",
      before: { share: 0.67, messageCount: 2 },
      after: { share: 0.34, messageCount: 1 },
    });
    expect(c.rows[1]).toMatchObject({
      name: "Blue",
      before: { share: 0.33, messageCount: 1 },
      after: { share: 0.33, messageCount: 1 },
    });
    expect(c.rows[2]).toMatchObject({
      name: "Green",
      role: "quiet",
      before: { share: 0, messageCount: 0 },
      after: { share: 0.33, messageCount: 1 },
    });
  });

  it("lists every member of a larger group, not just the logged target and quiet members", () => {
    // The log names one target and at most two quiet members, so in a group
    // of four the second-most active member is in neither list.
    const s = session();
    const log = s.interventions[0];
    log.contributionSplit = [
      ...log.contributionSplit,
      { ...log.contributionSplit[1], userId: "@d:localhost", identityName: "Yellow", share: 0.2 },
    ];
    log.quietMembers = [...log.quietMembers, { userId: "@b:localhost", identityName: "Blue" }];
    const [c] = nudgeComparisons(s);
    expect(c.rows.map((r) => [r.name, r.role])).toEqual([
      ["Red", "target"],
      ["Yellow", "unaddressed"],
      ["Green", "quiet"],
      ["Blue", "quiet"],
    ]);
  });

  it("links by timestamp when the window record carries no intervention id", () => {
    const s = session();
    s.windowEvaluations![0].interventionId = null;
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBe(0);
    expect(c.basis).toBe("window");
  });

  it("falls back to message shares over the rest of the chat when no later window exists", () => {
    // The default timing (3 min warm-up, 4 min windows, 10 min chat) only
    // ever evaluates one window, so this is the common case in the study.
    const s = session();
    s.windowEvaluations = s.windowEvaluations!.filter((w) => w.windowIndex === 0);
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBe(0);
    expect(c.basis).toBe("messages");
    expect(c.live).toBe(false);
    expect(c.afterUntil).toBe(Date.parse("2026-09-01T10:10:00.000Z"));
    // Before: the window's message counts (Red 2, Blue 1, Green 0). After:
    // m4 (Red), m5 (Green), m6 (Blue) — the bot's own message is not counted.
    expect(c.rows[0]).toMatchObject({ name: "Red", before: { messageCount: 2 }, after: { messageCount: 1 } });
    expect(c.rows[0].before.share).toBeCloseTo(2 / 3);
    expect(c.rows[0].after.share).toBeCloseTo(1 / 3);
    expect(c.rows[1]).toMatchObject({ name: "Blue", role: "unaddressed", before: { messageCount: 1 }, after: { messageCount: 1 } });
    expect(c.rows[2]).toMatchObject({ name: "Green", before: { share: 0, messageCount: 0 }, after: { messageCount: 1 } });
    expect(c.activeBefore).toBe(2);
    expect(c.activeAfter).toBe(3);
  });

  it("counts a live session's fallback only up to now", () => {
    const s = session({ status: "running", completedAt: undefined, windowEvaluations: [] });
    const [c] = nudgeComparisons(s, Date.parse("2026-09-01T10:04:30.000Z"));
    expect(c.live).toBe(true);
    expect(c.afterUntil).toBe(Date.parse("2026-09-01T10:04:30.000Z"));
    expect(c.rows[0].after).toEqual({ share: 1, messageCount: 1, dominanceScore: 0 });
    expect(c.activeAfter).toBe(1);
  });

  it("still shows the before split when no window records exist at all", () => {
    const s = session({ windowEvaluations: [] });
    const [c] = nudgeComparisons(s);
    expect(c.windowIndex).toBeNull();
    expect(c.basis).toBe("messages");
    expect(c.rows[0].before.messageCount).toBe(2);
    expect(c.rows[0].before.share).toBeCloseTo(2 / 3);
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

describe("spreadLabels", () => {
  it("keeps labels at their line ends when they do not collide", () => {
    expect(spreadLabels([30, 100, 60], 12, 0, 140)).toEqual([30, 100, 60]);
  });

  it("pushes colliding labels apart in their original order", () => {
    expect(spreadLabels([50, 50, 55], 12, 0, 140)).toEqual([50, 62, 74]);
  });

  it("pushes a stack that would leave the plot back up above the bottom edge", () => {
    // Four lines at 0% end on the bottom edge — the case that ran into the time axis.
    expect(spreadLabels([140, 140, 140, 140], 12, 0, 140)).toEqual([104, 116, 128, 140]);
  });

  it("clamps labels that start outside the plot", () => {
    expect(spreadLabels([-20, 200], 12, 0, 140)).toEqual([0, 140]);
  });
});

describe("formatters", () => {
  it("format clocks and shares", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_400)).toBe("1:05");
    expect(formatShare(0.666)).toBe("67%");
  });
});

// Type-level guard: the builder must produce a complete Session.
const _typed: Session = session();
void _typed;
