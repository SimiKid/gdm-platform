import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { shuffleRankingOrder, StoreService } from "./store.service";
import type { Participant } from "@gdm/shared";

const participant = (id: string): Participant => ({
  id,
  name: "",
  trackingToken: "t",
});

describe("StoreService", () => {
  let store: StoreService;
  beforeEach(() => {
    store = new StoreService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds the five study conditions", async () => {
    const conditions = await store.listConditions();
    expect(conditions).toHaveLength(5);
    expect(conditions[0]).toMatchObject({ active: true, goal: 5, groupSize: 3 });
    expect(conditions.map((c) => c.config.interventionMode)).toEqual([
      "baseline",
      "public",
      "public",
      "private",
      "private",
    ]);
    expect(conditions.every((c) => c.config.workspaceMode === "ranking")).toBe(
      true,
    );
  });

  it("upsertCondition updates editable condition settings", async () => {
    const condition = (await store.listConditions())[0];
    const updated = await store.upsertCondition({
      ...condition,
      active: false,
      goal: 7,
      config: {
        ...condition.config,
        contributionThreshold: 0.5,
      },
    });
    expect(updated.active).toBe(false);
    expect(updated.goal).toBe(7);
    expect(updated.config.contributionThreshold).toBe(0.5);
  });

  it("keeps ranking as the safe workspace default", async () => {
    const condition = (await store.listConditions())[0];
    const legacy = await store.upsertCondition({
      ...condition,
      config: {
        ...condition.config,
        workspaceMode: undefined,
      },
    });
    expect(legacy.config.workspaceMode).toBe("ranking");

    const external = await store.upsertCondition({
      ...condition,
      config: {
        ...condition.config,
        workspaceMode: "external",
      },
    });
    expect(external.config.workspaceMode).toBe("external");
  });

  it("createForming builds a waiting session seeded with the ranking task", async () => {
    const cond = (await store.listConditions())[0];
    const session = await store.createForming(cond);
    expect(session.status).toBe("waiting");
    expect(session.participants).toEqual([]);
    expect(session.rankingTask.items.length).toBeGreaterThan(0);
    expect(session.ranking.order).toHaveLength(session.rankingTask.items.length);
    expect([...session.ranking.order].sort()).toEqual(
      session.rankingTask.items.map((item) => item.id).sort(),
    );
    expect(session.interventions).toEqual([]);
    expect(await store.getSession(session.id)).toBe(session);
  });

  it("shuffles a ranking without mutating the task item order", () => {
    const itemIds = ["a", "b", "c", "d"];
    const shuffled = shuffleRankingOrder(itemIds, () => 0);

    expect(shuffled).toEqual(["b", "c", "d", "a"]);
    expect(itemIds).toEqual(["a", "b", "c", "d"]);
  });

  it("findForming returns the oldest waiting session with a free seat", async () => {
    const cond = (await store.listConditions())[0];
    const session = await store.createForming(cond);
    expect((await store.findForming())?.id).toBe(session.id);

    session.participants.push(participant("1"), participant("2"), participant("3"));
    await store.saveSession(session);
    expect(await store.findForming()).toBeUndefined();
  });

  it("counts claimed (non-aborted) and completed sessions per condition", async () => {
    const cond = (await store.listConditions())[0];
    const session = await store.createForming(cond);
    expect(await store.claimedCount(cond.id, 1)).toBe(1);
    expect(await store.completedCount(cond.id, 1)).toBe(0);

    session.status = "completed";
    await store.saveSession(session);
    expect(await store.completedCount(cond.id, 1)).toBe(1);
    expect(await store.claimedCount(cond.id, 1)).toBe(1);

    session.status = "aborted";
    await store.saveSession(session);
    expect(await store.claimedCount(cond.id, 1)).toBe(0);
  });

  it("stores participant Matrix credentials outside the session DTO", async () => {
    const cond = (await store.listConditions())[0];
    const session = await store.createForming(cond);
    session.participants.push(participant("p1"));
    await store.saveSession(session);

    await store.setParticipantCreds("p1", {
      userId: "@p1:localhost",
      accessToken: "tok",
    });
    expect(await store.getParticipantCreds("p1")).toEqual({
      userId: "@p1:localhost",
      accessToken: "tok",
    });
  });

  it("stores and returns study-wide settings (compensation link)", async () => {
    expect(await store.getStudySettings()).toEqual({
      compensationUrl: "",
      noConsentUrl: "",
      ineligibleUrl: "",
      withdrawalUrl: "",
      unmatchedUrl: "",
      technicalFailureUrl: "",
    });
    const updated = await store.updateStudySettings({
      compensationUrl: "  https://pay.example.com/done  ",
    });
    expect(updated.compensationUrl).toBe("https://pay.example.com/done");
    expect(await store.getStudySettings()).toEqual({
      compensationUrl: "https://pay.example.com/done",
      noConsentUrl: "",
      ineligibleUrl: "",
      withdrawalUrl: "",
      unmatchedUrl: "",
      technicalFailureUrl: "",
    });
  });

  it("keeps participation stages monotonic and terminal outcomes immutable", async () => {
    const identity = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    await store.recordParticipationStage(identity, "waiting");
    await store.recordParticipationStage(identity, "entry");
    expect((await store.getProlificArrival(identity))?.stage).toBe("waiting");

    const first = await store.terminateProlificParticipation(
      identity,
      "unmatched",
      "deadline",
      "partial",
      100,
    );
    const duplicate = await store.terminateProlificParticipation(
      identity,
      "technical_failure",
      "later retry",
      "partial",
      500,
    );
    expect(duplicate).toMatchObject({
      outcome: first.outcome,
      compensationAmountPence: 100,
      stage: "terminated",
    });
  });

  it("only atomically terminates an arrival that is still stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-08-31T10:00:00.000Z");
    const identity = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    await store.recordParticipationStage(identity, "waiting");
    vi.setSystemTime("2026-08-31T10:00:20.000Z");
    await store.recordParticipationStage(identity, "waiting");

    await expect(
      store.terminateStaleProlificParticipation(
        identity,
        new Date("2026-08-31T10:00:10.000Z"),
        "connection_timeout",
        "stale",
        "partial",
        10,
      ),
    ).resolves.toBeNull();

    const ended = await store.terminateStaleProlificParticipation(
      identity,
      new Date("2026-08-31T10:00:20.000Z"),
      "connection_timeout",
      "stale",
      "partial",
      10,
    );
    expect(ended).toMatchObject({
      outcome: "connection_timeout",
      stage: "terminated",
      compensationAmountPence: 10,
    });
  });
});
