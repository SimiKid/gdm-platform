import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { InterventionLog, Message, Ranking } from "@gdm/shared";
import { SessionsService } from "../../src/sessions/sessions.service";
import { PrismaService } from "../../src/prisma/prisma.service";
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
      mode: "public",
      audience: "public",
      timestamp: "2026-07-07T10:04:00.000Z",
      trigger: "contribution-threshold",
      threshold: 0.4,
      llmMode: "off",
      contributionWindowMinutes: 4,
      contributionSplit: [
        {
          userId: userIds[0],
          identityName: "Crimson",
          messageCount: 5,
          wordCount: 44,
          score: 7.2,
          share: 0.55,
          meaningfulnessScore: 0,
          dominanceScore: 0.55,
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
      await request(t.http)
        .get(`/api/sessions/${sessionId}`)
        .set("Authorization", "Bearer tt-P1-baseline")
        .expect(200)
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
    const storedParticipants = await t.app
      .get(PrismaService)
      .participantRecord.findMany({ where: { sessionId } });
    expect(storedParticipants).toHaveLength(3);
    expect(storedParticipants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recruitmentSource: "direct",
          prolificPid: null,
          prolificStudyId: null,
          prolificSessionId: null,
        }),
      ]),
    );

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

  it("accepts live checkpoints larger than Express's 100 KB default", async () => {
    const responses = await fillSession(t, "public-llm");
    const sessionId = responses[0].session.id;
    const senderId = responses[0].matrix.userId;
    const largePrompt = "classification context ".repeat(6_000);

    const checkpoint = await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send({
        messages: [],
        rankingHistory: [],
        contributionClassifications: [
          {
            messageId: "$large:test",
            senderId,
            classifiedAt: "2026-07-07T10:00:00.000Z",
            respondsToPrior: { value: false, reason: "" },
            referencesTaskItem: { value: false, reason: "" },
            hasDiscussionStructure: { value: false, reason: "" },
            invitesParticipation: { value: false, reason: "" },
            meaningfulnessScore: 0,
            model: "test-model",
            promptVersion: "test-v1",
            prompt: largePrompt,
            rawOutput: "{}",
          },
        ],
      })
      .expect(200);

    expect(checkpoint.body).toEqual({ ok: true });
    const stored = (
      await request(t.http).get(`/api/admin/sessions/${sessionId}`).expect(200)
    ).body;
    expect(stored.contributionClassifications).toHaveLength(1);
    expect(stored.contributionClassifications[0].prompt).toHaveLength(
      largePrompt.length,
    );
  });

  it("merges partial/retried checkpoints without losing newer chat, survey, or completion data", async () => {
    const opened = await openSession(t, "Checkpoint-safe", "baseline");
    const sessionId = opened.session.id;
    const participantId = opened.participantId;
    const senderId = opened.matrix.userId;
    const taskId = opened.session.rankingTask.id;
    const baseOrder = opened.session.ranking.order;
    const ranking1: Ranking = {
      taskId,
      order: baseOrder,
      updatedAt: "2030-08-05T09:00:00.000Z",
      updatedBy: participantId,
    };
    const ranking2: Ranking = {
      taskId,
      order: [...baseOrder].reverse(),
      // Client clocks can move backwards; checkpoint revision/event order is
      // authoritative for the current shared ranking.
      updatedAt: "2030-08-05T08:59:00.000Z",
      updatedBy: participantId,
    };
    const firstCheckpoint = {
      revision: 1,
      messages: [
        {
          id: "$safe-1:test",
          timestamp: "2030-08-05T09:00:00.000Z",
          senderId,
          text: "first durable message",
          reactions: [
            {
              key: "👍",
              senderId: "@peer:test",
              timestamp: "2030-08-05T09:00:01.000Z",
            },
          ],
        },
      ],
      rankingHistory: [ranking1],
      behavioralEvents: [
        {
          id: "$behavior-1:test",
          type: "typing-stop",
          participantId: senderId,
          timestamp: "2030-08-05T09:00:02.000Z",
          durationMs: 500,
        },
      ],
      processedEventIds: ["$safe-1:test"],
      ruleState: { phase: 1 },
    };
    const secondCheckpoint = {
      revision: 2,
      // Deliberately partial: this proves an incomplete/later request cannot
      // erase rows committed by an earlier full snapshot.
      messages: [
        {
          id: "$safe-2:test",
          timestamp: "2030-08-05T09:01:00.000Z",
          senderId,
          text: "second durable message",
          reactions: [],
        },
      ],
      rankingHistory: [ranking2],
      behavioralEvents: [
        {
          id: "$behavior-2:test",
          type: "cursor-activity",
          participantId: senderId,
          timestamp: "2030-08-05T09:01:02.000Z",
        },
      ],
      processedEventIds: ["$safe-2:test"],
      ruleState: { phase: 2 },
    };

    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(firstCheckpoint)
      .expect(200);
    await Promise.all([
      request(t.http)
        .put(`/api/sessions/${sessionId}/checkpoint`)
        .send(secondCheckpoint)
        .expect(200),
      request(t.http)
        .post("/api/surveys")
        .set("Authorization", "Bearer tt-Checkpoint-safe")
        .send({
          sessionId,
          participantId,
          kind: "exit",
          survey: {
            answers: { preserved: true },
            submittedAt: "2030-08-05T09:02:00.000Z",
          },
        })
        .expect(201),
    ]);
    const completion = (
      await request(t.http)
        .post(`/api/sessions/${sessionId}/participants/${participantId}/complete`)
        .set("Authorization", "Bearer tt-Checkpoint-safe")
        .expect(201)
    ).body;

    // A late old request and an exact retry are both harmless.
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(firstCheckpoint)
      .expect(200);
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(secondCheckpoint)
      .expect(200);

    await t.close();
    t = await createTestApp();
    const stored = (
      await request(t.http).get(`/api/admin/sessions/${sessionId}`).expect(200)
    ).body;
    expect(stored.chat.messages.map((message: Message) => message.id)).toEqual([
      "$safe-1:test",
      "$safe-2:test",
    ]);
    expect(stored.chat.messages[0].reactions).toHaveLength(1);
    expect(stored.rankingHistory).toEqual([ranking1, ranking2]);
    expect(stored.ranking).toEqual(ranking2);
    expect(stored.behavioralEvents.map((event: { id: string }) => event.id)).toEqual([
      "$behavior-1:test",
      "$behavior-2:test",
    ]);
    expect(stored.processedEventIds).toEqual([
      "$safe-1:test",
      "$safe-2:test",
    ]);
    expect(stored.runtimeState).toMatchObject({ phase: 2 });
    expect(stored.checkpointRevision).toBe(2);
    expect(stored.participants[0].exitSurvey.answers).toEqual({ preserved: true });
    expect(stored.participants[0].completedAt).toBe(completion.completedAt);
  });

  it("keeps reaction redactions monotonic without deleting the audit event", async () => {
    const opened = await openSession(t, "Reaction-safe", "baseline");
    const sessionId = opened.session.id;
    const message = {
      id: "$reaction-message:test",
      timestamp: "2030-08-05T10:00:00.000Z",
      senderId: opened.matrix.userId,
      text: "react to this",
      reactions: [
        {
          eventId: "$reaction:test",
          key: "👍",
          senderId: "@peer:test",
          timestamp: "2030-08-05T10:00:01.000Z",
        },
      ],
    };
    const activeReaction = {
      eventId: "$reaction:test",
      messageId: message.id,
      key: "👍",
      senderId: "@peer:test",
      timestamp: "2030-08-05T10:00:01.000Z",
      redacted: false,
    };
    const checkpoint1 = {
      revision: 1,
      messages: [message],
      rankingHistory: [],
      processedEventIds: [message.id, activeReaction.eventId],
      reactionEvents: [activeReaction],
      ruleState: {},
    };
    const legacyCheckpoint = {
      ...checkpoint1,
      revision: 0,
      messages: [
        {
          ...message,
          reactions: message.reactions.map(({ eventId: _eventId, ...reaction }) =>
            reaction
          ),
        },
      ],
      reactionEvents: undefined,
    };
    const checkpoint2 = {
      ...checkpoint1,
      revision: 2,
      messages: [{ ...message, reactions: [] }],
      processedEventIds: [
        message.id,
        activeReaction.eventId,
        "$redaction:test",
      ],
      redactedReactionEventIds: [activeReaction.eventId],
      reactionEvents: [
        {
          ...activeReaction,
          redacted: true,
          redactionEventId: "$redaction:test",
          redactedAt: "2030-08-05T10:00:02.000Z",
        },
      ],
    };

    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(legacyCheckpoint)
      .expect(200);
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(checkpoint1)
      .expect(200);
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(checkpoint2)
      .expect(200);
    // A delayed older full snapshot must not make the emoji active again.
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(checkpoint1)
      .expect(200);

    await t.close();
    t = await createTestApp();
    const stored = (
      await request(t.http).get(`/api/admin/sessions/${sessionId}`).expect(200)
    ).body;
    expect(stored.chat.messages[0].reactions).toEqual([]);
    expect(stored.redactedReactionEventIds).toEqual([activeReaction.eventId]);
    expect(stored.reactionEvents).toEqual([
      expect.objectContaining({
        eventId: activeReaction.eventId,
        redacted: true,
        redactionEventId: "$redaction:test",
      }),
    ]);
  });

  it("stores entry and exit surveys and overwrites on resubmission", async () => {
    const opened = await openSession(t, "Solo", "baseline");
    const { participantId } = opened;
    const sessionId = opened.session.id;

    const submit = (kind: "entry" | "exit", answers: Record<string, unknown>) =>
      request(t.http)
        .post("/api/surveys")
        .set("Authorization", "Bearer tt-Solo")
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
      .set("Authorization", "Bearer tt-Solo")
      .send({
        sessionId,
        participantId: "ghost",
        kind: "entry",
        survey: { answers: {}, submittedAt: "2026-07-07T09:00:00.000Z" },
      })
      .expect(401);

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

  it("persists Prolific arrival, participant identity, and individual completion", async () => {
    const prolific = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    await request(t.http)
      .post("/api/prolific/arrivals")
      .send({ prolific })
      .expect(201);

    const opened = (
      await request(t.http)
        .post("/api/sessions")
        .send({
          trackingToken: `prolific:${prolific.studyId}:${prolific.sessionId}`,
          participantName: "",
          conditionId: "baseline",
          prolific,
        })
        .expect(201)
    ).body;
    await request(t.http)
      .post("/api/surveys")
      .set(
        "Authorization",
        `Bearer prolific:${prolific.studyId}:${prolific.sessionId}`,
      )
      .send({
        sessionId: opened.session.id,
        participantId: opened.participantId,
        kind: "exit",
        survey: {
          answers: { satisfaction: 7 },
          submittedAt: "2026-07-26T10:00:00.000Z",
        },
      })
      .expect(201);
    const completion = (
      await request(t.http)
        .post(
          `/api/sessions/${opened.session.id}/participants/${opened.participantId}/complete`,
        )
        .set(
          "Authorization",
          `Bearer prolific:${prolific.studyId}:${prolific.sessionId}`,
        )
        .expect(201)
    ).body;
    expect(completion.completedAt).toBeDefined();

    await t.close();
    t = await createTestApp();

    const arrivals = (
      await request(t.http).get("/api/export/prolific-arrivals").expect(200)
    ).body;
    expect(arrivals[0]).toMatchObject({
      ...prolific,
      participantRecordId: opened.participantId,
    });
    const detailed = (
      await request(t.http).get("/api/export/sessions").expect(200)
    ).body.sessions[0].participants[0];
    expect(detailed.prolific).toEqual(prolific);
    expect(detailed.recruitmentSource).toBe("prolific");
    expect(detailed.completedAt).toBe(completion.completedAt);
    const outcomes = (
      await request(t.http).get("/api/export/prolific-outcomes").expect(200)
    ).body.outcomes;
    expect(outcomes[0]).toMatchObject({
      ...prolific,
      stage: "done",
      outcome: "completed",
      compensationKind: "full",
      prolificActionStatus: "not_required",
    });
  });

  it("persists a stale-heartbeat timeout and releases the waiting seat", async () => {
    const prolific = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    const opened = (
      await request(t.http)
        .post("/api/sessions")
        .send({
          trackingToken: `prolific:${prolific.studyId}:${prolific.sessionId}`,
          participantName: "",
          conditionId: "baseline",
          prolific,
        })
        .expect(201)
    ).body;
    const prisma = t.app.get(PrismaService);
    await prisma.prolificArrivalRecord.update({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: prolific.studyId,
          prolificSessionId: prolific.sessionId,
        },
      },
      data: { lastSeenAt: new Date(Date.now() - 31_000) },
    });

    expect(
      await t.app.get(SessionsService).sweepDisconnectedParticipants(),
    ).toBe(1);
    const outcome = (
      await request(t.http)
        .post("/api/prolific/outcome")
        .send({ prolific })
        .expect(201)
    ).body;
    expect(outcome).toMatchObject({
      outcome: "connection_timeout",
      compensationKind: "partial",
      compensationAmountPence: 10,
    });
    const session = await prisma.sessionRecord.findUniqueOrThrow({
      where: { id: opened.session.id },
      include: { participants: true },
    });
    expect(session.status).toBe("aborted");
    expect(session.participants).toHaveLength(0);
  });

  it("persists study settings across restarts", async () => {
    await request(t.http)
      .put("/api/settings")
      .send({
        settings: {
          compensationUrl: "  https://pay.example/done  ",
          unmatchedUrl: "https://app.prolific.com/return?cc=UNMATCHED",
        },
      })
      .expect(200);

    await t.close();
    t = await createTestApp();

    const settings = (await request(t.http).get("/api/settings").expect(200)).body;
    expect(settings.compensationUrl).toBe("https://pay.example/done");
    expect(settings.unmatchedUrl).toBe(
      "https://app.prolific.com/return?cc=UNMATCHED",
    );
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

    // Session 2 (public-rule): finalized empty.
    const other = await fillSession(t, "public-rule");
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
