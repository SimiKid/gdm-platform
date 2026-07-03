import { describe, it, expect, beforeEach } from "vitest";
import { StoreService } from "./store.service";
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

  it("seeds three active conditions", () => {
    const conditions = store.listConditions();
    expect(conditions).toHaveLength(3);
    expect(conditions[0]).toMatchObject({ active: true, goal: 5, groupSize: 3 });
  });

  it("createForming builds a waiting session seeded with the ranking task", () => {
    const cond = store.listConditions()[0];
    const session = store.createForming(cond);
    expect(session.status).toBe("waiting");
    expect(session.participants).toEqual([]);
    expect(session.rankingTask.items.length).toBeGreaterThan(0);
    expect(session.ranking.order).toHaveLength(session.rankingTask.items.length);
    expect(store.getSession(session.id)).toBe(session);
  });

  it("findForming returns the oldest waiting session with a free seat", () => {
    const cond = store.listConditions()[0];
    const session = store.createForming(cond);
    expect(store.findForming()?.id).toBe(session.id);

    session.participants.push(participant("1"), participant("2"), participant("3"));
    expect(store.findForming()).toBeUndefined();
  });

  it("counts claimed (non-aborted) and completed sessions per condition", () => {
    const cond = store.listConditions()[0];
    const session = store.createForming(cond);
    expect(store.claimedCount(cond.id)).toBe(1);
    expect(store.completedCount(cond.id)).toBe(0);

    session.status = "completed";
    expect(store.completedCount(cond.id)).toBe(1);
    expect(store.claimedCount(cond.id)).toBe(1);

    session.status = "aborted";
    expect(store.claimedCount(cond.id)).toBe(0);
  });
});
