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
      "public-rule",
      "public-llm",
      "private-rule",
      "private-llm",
    ]);
    expect(conditions[0]).toMatchObject({
      active: true,
      goal: 5,
      groupSize: 3,
      durationMinutes: 10,
    });
    // Condition knobs (JSON column) survive the round-trip.
    expect(conditions[0].config.interventionMode).toBe("baseline");
    expect(conditions[0].config.scoreWeights).toEqual({ messages: 1, words: 0.05 });
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

    // Provisioning: one room, every participant invited + joined with their
    // own token, plus an invite for the chat-service bot (invite-only room).
    expect(t.matrix.createdRooms).toEqual(["!room-1:test"]);
    expect(t.matrix.joins.map((j) => j.accessToken).sort()).toEqual([
      "token-1",
      "token-2",
      "token-3",
    ]);
    expect(t.matrix.invites).toContainEqual({
      roomId: "!room-1:test",
      userId: "@gdm_bot:test",
    });

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
    expect(fourth.session.condition.id).toBe("public-rule");
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

  it("hands the same seat back when a token rejoins (browser refresh)", async () => {
    const first = await openSession(t, "Anna", "baseline");
    const again = await openSession(t, "Anna", "baseline");

    expect(again.session.id).toBe(first.session.id);
    expect(again.participantId).toBe(first.participantId);
    expect(again.matrix.accessToken).toBe(first.matrix.accessToken);
    expect(again.session.participants).toHaveLength(1);
  });

  it("does not leak tracking tokens or surveys through participant endpoints", async () => {
    const first = await openSession(t, "Anna", "baseline");
    await request(t.http)
      .post("/api/surveys")
      .send({
        sessionId: first.session.id,
        participantId: first.participantId,
        kind: "entry",
        survey: { answers: { secret: "yes" }, submittedAt: "now" },
      })
      .expect(201);

    const polled = await request(t.http)
      .get(`/api/sessions/${first.session.id}`)
      .expect(200);
    const raw = JSON.stringify(polled.body);
    expect(raw).not.toContain("tt-Anna");
    expect(raw).not.toContain("secret");
    expect(polled.body.participants).toHaveLength(1);
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

  it("study rounds: start aborts lobbies, resets progress, and round-scopes matchmaking", async () => {
    // Lazy Round 1 exists even after a TRUNCATE.
    const initial = (await request(t.http).get("/api/rounds").expect(200))
      .body as { currentRound: number; rounds: unknown[] };
    expect(initial.currentRound).toBe(1);

    // A half-filled round-1 lobby…
    const first = await openSession(t, "R1", "baseline");
    expect(first.session.roundId).toBe(1);

    const started = (
      await request(t.http)
        .post("/api/rounds")
        .send({ label: "wave 2" })
        .expect(201)
    ).body as { round: { number: number; label: string }; abortedWaitingSessions: number };
    expect(started.round).toMatchObject({ number: 2, label: "wave 2" });
    expect(started.abortedWaitingSessions).toBe(1);

    // …is aborted, and the next joiner opens a fresh round-2 session.
    const next = await openSession(t, "R2", "baseline");
    expect(next.session.id).not.toBe(first.session.id);
    expect(next.session.roundId).toBe(2);

    // Progress counts the current round only: nothing completed yet.
    const progress = (
      await request(t.http).get("/api/conditions/progress").expect(200)
    ).body as Array<{ condition: { id: string }; completed: number }>;
    expect(progress.every((row) => row.completed === 0)).toBe(true);

    // Round ids survive Postgres round-trips across an app restart.
    await t.close();
    t = await createTestApp();
    const rounds = (await request(t.http).get("/api/rounds").expect(200))
      .body as {
      currentRound: number;
      rounds: Array<{ number: number; label: string; endedAt?: string }>;
    };
    expect(rounds.currentRound).toBe(2);
    expect(rounds.rounds).toHaveLength(2);
    expect(rounds.rounds[0].endedAt).toBeDefined();
    const reloaded = (
      await request(t.http)
        .get(`/api/admin/sessions/${next.session.id}`)
        .expect(200)
    ).body as { roundId: number };
    expect(reloaded.roundId).toBe(2);
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
