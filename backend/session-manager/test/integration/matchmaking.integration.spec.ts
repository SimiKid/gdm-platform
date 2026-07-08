import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Condition } from "@gdm/shared";
import {
  closeHarness,
  createTestApp,
  fillSession,
  openSession,
  resetDatabase,
  type TestApp,
} from "./harness";

/**
 * Matchmaking and session lifecycle through the real HTTP API, backed by a
 * real Postgres. Synapse and the Chat Service are the only fakes.
 */
describe("matchmaking & lifecycle (integration)", () => {
  let t: TestApp;

  beforeEach(async () => {
    await resetDatabase();
    t = await createTestApp();
  });

  afterEach(() => t.close());
  afterAll(closeHarness);

  it("seeds the five study conditions into Postgres", async () => {
    const res = await request(t.http).get("/api/conditions").expect(200);
    const conditions = res.body as Condition[];
    expect(conditions.map((c) => c.id)).toEqual([
      "baseline",
      "public-neutral",
      "public-engaging",
      "private-neutral",
      "private-engaging",
    ]);
    expect(conditions[0]).toMatchObject({
      active: true,
      goal: 5,
      groupSize: 3,
      durationMinutes: 10,
    });
    // Condition knobs (JSON column) survive the round-trip.
    expect(conditions[0].config.interventionMode).toBe("baseline");
    expect(conditions[0].config.scoreWeights).toEqual({ messages: 1, characters: 0.01 });
  });

  it("fills a group seat by seat and provisions the room on the last seat", async () => {
    const first = await openSession(t, "Anna", "baseline");
    expect(first.session.status).toBe("waiting");
    expect(first.matrix.roomId).toBe("");
    expect(first.matrix.userId).toBe("@gdm_1:test");

    const second = await openSession(t, "Ben", "baseline");
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.status).toBe("waiting");
    expect(second.session.participants).toHaveLength(2);

    const third = await openSession(t, "Cleo", "baseline");
    expect(third.session.id).toBe(first.session.id);
    expect(third.session.status).toBe("running");
    expect(third.session.startedAt).toBeDefined();
    expect(third.matrix.roomId).toBe("!room-1:test");

    // Provisioning: one room, every participant joined with their own token.
    expect(t.matrix.createdRooms).toEqual(["!room-1:test"]);
    expect(t.matrix.joins.map((j) => j.accessToken).sort()).toEqual([
      "token-1",
      "token-2",
      "token-3",
    ]);

    // The Chat Service was handed the live session.
    expect(t.chatServiceCalls).toHaveLength(1);
    expect(t.chatServiceCalls[0].url).toContain("/internal/sessions/start");
    expect(t.chatServiceCalls[0].body).toMatchObject({
      sessionId: first.session.id,
      roomId: "!room-1:test",
      durationMinutes: 10,
    });
    expect(t.chatServiceCalls[0].body.condition.id).toBe("baseline");

    // What the Waiting Room polls comes back from Postgres, not memory.
    const polled = await request(t.http)
      .get(`/api/sessions/${first.session.id}`)
      .expect(200);
    expect(polled.body.status).toBe("running");
    expect(polled.body.roomId).toBe("!room-1:test");
    expect(polled.body.participants).toHaveLength(3);
  });

  it("assigns the least-claimed active condition and reuses forming sessions", async () => {
    // One baseline session claimed → baseline is no longer least-claimed.
    await fillSession(t, "baseline");

    const fourth = await openSession(t, "Dora");
    expect(fourth.session.condition.id).toBe("public-neutral");
    expect(fourth.session.status).toBe("waiting");

    // The next unforced participant joins that forming session instead of
    // opening a new one.
    const fifth = await openSession(t, "Emil");
    expect(fifth.session.id).toBe(fourth.session.id);
    expect(fifth.session.participants).toHaveLength(2);
  });

  it("seats simultaneous joiners into one group, not one group each", async () => {
    // Three participants click through at the same moment (a recruiting burst).
    const responses = await Promise.all(
      ["Ann", "Bo", "Cy"].map((name) =>
        request(t.http)
          .post("/api/sessions")
          .send({ trackingToken: `tt-${name}`, participantName: name, conditionId: "baseline" })
          .expect(201)
          .then((res) => res.body),
      ),
    );

    const sessionIds = new Set(responses.map((r) => r.session.id));
    expect(sessionIds.size).toBe(1);
    expect(t.matrix.createdRooms).toHaveLength(1);
    expect(responses.some((r) => r.session.status === "running")).toBe(true);
  });

  it("returns 404 for an unknown condition", async () => {
    await request(t.http)
      .post("/api/sessions")
      .send({ trackingToken: "tt-x", participantName: "X", conditionId: "nope" })
      .expect(404);
  });

  it("returns 409 for a deactivated condition", async () => {
    const conditions = (await request(t.http).get("/api/conditions").expect(200))
      .body as Condition[];
    const baseline = conditions.find((c) => c.id === "baseline")!;

    await request(t.http)
      .put("/api/conditions/baseline")
      .send({ condition: { ...baseline, active: false } })
      .expect(200);

    await request(t.http)
      .post("/api/sessions")
      .send({ trackingToken: "tt-x", participantName: "X", conditionId: "baseline" })
      .expect(409);
  });

  it("returns 409 for a condition that reached its goal", async () => {
    const conditions = (await request(t.http).get("/api/conditions").expect(200))
      .body as Condition[];
    const baseline = conditions.find((c) => c.id === "baseline")!;

    await request(t.http)
      .put("/api/conditions/baseline")
      .send({ condition: { ...baseline, goal: 0 } })
      .expect(200);

    await request(t.http)
      .post("/api/sessions")
      .send({ trackingToken: "tt-x", participantName: "X", conditionId: "baseline" })
      .expect(409);
  });

  it("returns 409 when the whole study is full", async () => {
    const conditions = (await request(t.http).get("/api/conditions").expect(200))
      .body as Condition[];
    for (const condition of conditions) {
      await request(t.http)
        .put(`/api/conditions/${condition.id}`)
        .send({ condition: { ...condition, active: false } })
        .expect(200);
    }

    await request(t.http)
      .post("/api/sessions")
      .send({ trackingToken: "tt-x", participantName: "X" })
      .expect(409);
  });

  it("persists condition edits across an app restart", async () => {
    const conditions = (await request(t.http).get("/api/conditions").expect(200))
      .body as Condition[];
    const baseline = conditions.find((c) => c.id === "baseline")!;

    await request(t.http)
      .put("/api/conditions/baseline")
      .send({ condition: { ...baseline, goal: 7, durationMinutes: 15 } })
      .expect(200);

    await t.close();
    t = await createTestApp();

    const after = (await request(t.http).get("/api/conditions").expect(200))
      .body as Condition[];
    const reloaded = after.find((c) => c.id === "baseline")!;
    expect(reloaded.goal).toBe(7);
    expect(reloaded.durationMinutes).toBe(15);
  });
});
