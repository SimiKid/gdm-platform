import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { InterventionLog, Message, Ranking } from "@gdm/shared";
import {
  closeHarness,
  createTestApp,
  fillSession,
  openSession,
  resetDatabase,
  type TestApp,
} from "./harness";

/**
 * The finalize → Postgres → read-back path. Every assertion after an app
 * restart proves the data came out of the database (a fresh app has no
 * in-memory state), covering the Prisma mapping in StoreService that the
 * unit tests never touch.
 */
describe("persistence & exports (integration)", () => {
  let t: TestApp;

  beforeEach(async () => {
    await resetDatabase();
    t = await createTestApp();
  });

  afterEach(() => t.close());
  afterAll(closeHarness);

  it("round-trips a finalized session across an app restart", async () => {
    const responses = await fillSession(t, "baseline");
    const sessionId = responses[0].session.id;
    const roomId = "!room-1:test";
    const userIds = responses.map((r) => r.matrix.userId);
    const task = responses[0].session.rankingTask;

    const messages: Message[] = [
      {
        id: "$m1:test",
        timestamp: "2026-07-07T10:00:00.000Z",
        senderId: userIds[0],
        text: 'Hello, "team" — let us start',
        reactions: [
          { key: "👍", senderId: userIds[1], timestamp: "2026-07-07T10:00:05.000Z" },
          { key: "🚀", senderId: userIds[2], timestamp: "2026-07-07T10:00:07.000Z" },
        ],
      },
      {
        id: "$m2:test",
        timestamp: "2026-07-07T10:01:00.000Z",
        senderId: "@bot:test",
        recipientId: userIds[2],
        text: "Private nudge: what do you think?",
        reactions: [],
      },
    ];

    const rankingHistory: Ranking[] = [
      {
        taskId: task.id,
        order: task.items.map((i) => i.id),
        updatedAt: "2026-07-07T10:02:00.000Z",
        updatedBy: responses[0].participantId,
      },
      {
        taskId: task.id,
        order: [...task.items.map((i) => i.id)].reverse(),
        updatedAt: "2026-07-07T10:03:00.000Z",
        updatedBy: responses[1].participantId,
      },
    ];

    const intervention: InterventionLog = {
      id: "int-1",
      sessionId,
      roomId,
      conditionId: "baseline",
      mode: "public-neutral",
      audience: "public",
      tone: "neutral",
      timestamp: "2026-07-07T10:04:00.000Z",
      trigger: "contribution-threshold",
      threshold: 0.4,
      contributionWindowMinutes: 4,
      contributionSplit: [
        {
          userId: userIds[0],
          identityName: "Crimson",
          messageCount: 5,
          characterCount: 220,
          score: 7.2,
          share: 0.55,
        },
      ],
      targets: [{ userId: userIds[0], identityName: "Crimson" }],
      quietMembers: [{ userId: userIds[2], identityName: "Teal" }],
      message: "Let's hear from the quieter voices.",
    };

    const finalized = await request(t.http)
      .post(`/api/sessions/${sessionId}/finalize`)
      .send({ messages, rankingHistory, interventions: [intervention] })
      .expect(201);
    expect(finalized.body.status).toBe("completed");

    // Restart: a fresh app instance can only answer from Postgres.
    await t.close();
    t = await createTestApp();

    const session = (
      await request(t.http).get(`/api/sessions/${sessionId}`).expect(200)
    ).body;

    expect(session.status).toBe("completed");
    expect(session.completedAt).toBeDefined();
    expect(session.roomId).toBe(roomId);
    // Messages incl. reactions and the private recipient survive intact.
    expect(session.chat.messages).toEqual([
      { ...messages[0], recipientId: null },
      messages[1],
    ]);
    // Full ranking history in order; the session ranking is the last edit.
    expect(session.rankingHistory).toEqual(rankingHistory);
    expect(session.ranking).toEqual(rankingHistory[1]);
    expect(session.interventions).toEqual([intervention]);
    expect(session.participants).toHaveLength(3);
    expect(session.participants.map((p: { name: string }) => p.name)).toEqual([
      "P1-baseline",
      "P2-baseline",
      "P3-baseline",
    ]);

    // Summary list and per-condition progress are computed from the DB.
    const summaries = (await request(t.http).get("/api/sessions").expect(200)).body;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: sessionId,
      status: "completed",
      messageCount: 2,
      rankingEditCount: 2,
      interventionCount: 1,
      participantCount: 3,
    });

    const progress = (
      await request(t.http).get("/api/conditions/progress").expect(200)
    ).body;
    const baseline = progress.find(
      (p: { condition: { id: string } }) => p.condition.id === "baseline",
    );
    expect(baseline).toMatchObject({ completed: 1, goal: 5 });
  });

  it("stores entry and exit surveys and overwrites on resubmission", async () => {
    const opened = await openSession(t, "Solo", "baseline");
    const { participantId } = opened;
    const sessionId = opened.session.id;

    const submit = (kind: "entry" | "exit", answers: Record<string, unknown>) =>
      request(t.http)
        .post("/api/surveys")
        .send({
          sessionId,
          participantId,
          kind,
          survey: { answers, submittedAt: "2026-07-07T09:00:00.000Z" },
        });

    await submit("entry", { mood: "meh", ranking: ["a", "b"] }).expect(201);
    // Resubmitting the same kind must overwrite, not duplicate
    // (unique [participantId, kind] in the schema).
    await submit("entry", { mood: "good", ranking: ["b", "a"] }).expect(201);
    await submit("exit", { satisfaction: 5 }).expect(201);

    await request(t.http)
      .post("/api/surveys")
      .send({
        sessionId,
        participantId: "ghost",
        kind: "entry",
        survey: { answers: {}, submittedAt: "2026-07-07T09:00:00.000Z" },
      })
      .expect(404);

    await t.close();
    t = await createTestApp();

    const surveys = (
      await request(t.http).get("/api/export/surveys").expect(200)
    ).body.surveys;
    expect(surveys).toHaveLength(2);
    const entry = surveys.find((s: { kind: string }) => s.kind === "entry");
    const exit = surveys.find((s: { kind: string }) => s.kind === "exit");
    expect(entry.answers).toEqual({ mood: "good", ranking: ["b", "a"] });
    expect(exit.answers).toEqual({ satisfaction: 5 });
    expect(entry.participantId).toBe(participantId);
    expect(entry.trackingToken).toBe("tt-Solo");
  });

  it("persists study settings across restarts", async () => {
    await request(t.http)
      .put("/api/settings")
      .send({ settings: { compensationUrl: "  https://pay.example/done  " } })
      .expect(200);

    await t.close();
    t = await createTestApp();

    const settings = (await request(t.http).get("/api/settings").expect(200)).body;
    expect(settings.compensationUrl).toBe("https://pay.example/done");
  });

  it("exports CSV with escaping and condition filtering", async () => {
    // Session 1 (baseline): one message with CSV-hostile text.
    const baseline = await fillSession(t, "baseline");
    await request(t.http)
      .post(`/api/sessions/${baseline[0].session.id}/finalize`)
      .send({
        messages: [
          {
            id: "$m1:test",
            timestamp: "2026-07-07T10:00:00.000Z",
            senderId: baseline[0].matrix.userId,
            text: 'Ranked "oxygen", then water\nfinal answer',
            reactions: [{ key: "👍", senderId: "@x:test", timestamp: "2026-07-07T10:00:01.000Z" }],
          },
        ],
        rankingHistory: [],
      })
      .expect(201);

    // Session 2 (public-neutral): finalized empty.
    const other = await fillSession(t, "public-neutral");
    await request(t.http)
      .post(`/api/sessions/${other[0].session.id}/finalize`)
      .send({ messages: [], rankingHistory: [] })
      .expect(201);

    const sessionsCsv = await request(t.http)
      .get("/api/export/sessions.csv")
      .expect(200)
      .expect("Content-Type", /text\/csv/);
    // Header + one row per session (session rows contain no free text).
    expect(sessionsCsv.text.split("\n")).toHaveLength(3);
    expect(sessionsCsv.text).toContain("session_id,condition_id");

    const filtered = await request(t.http)
      .get("/api/export/sessions.csv?conditionIds=baseline")
      .expect(200);
    const filteredLines = filtered.text.split("\n");
    expect(filteredLines).toHaveLength(2);
    expect(filteredLines[1]).toContain(baseline[0].session.id);

    const messagesCsv = await request(t.http)
      .get("/api/export/messages.csv")
      .expect(200)
      .expect("Content-Type", /text\/csv/);
    // Quotes doubled, the whole cell quoted (contains comma + newline).
    expect(messagesCsv.text).toContain('"Ranked ""oxygen"", then water\nfinal answer"');
    expect(messagesCsv.text).toContain("👍");

    const json = (await request(t.http).get("/api/export/sessions").expect(200)).body;
    expect(json.sessions).toHaveLength(2);
  });
});
