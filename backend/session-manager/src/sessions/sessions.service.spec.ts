import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionsService } from "./sessions.service";
import { StoreService } from "../store/store.service";
import type { MatrixService } from "../matrix/matrix.service";
import type { Ranking } from "@gdm/shared";

function fakeMatrix(): MatrixService {
  let n = 0;
  return {
    registerUser: vi.fn(async () => {
      n += 1;
      return { userId: `@u${n}:localhost`, accessToken: `tok${n}` };
    }),
    createRoom: vi.fn(async () => "!room:localhost"),
    joinRoom: vi.fn(async () => undefined),
  } as unknown as MatrixService;
}

const open = { trackingToken: "t", participantName: "" };

describe("SessionsService (session-manager)", () => {
  let store: StoreService;
  let matrix: MatrixService;
  let svc: SessionsService;

  beforeEach(() => {
    store = new StoreService();
    matrix = fakeMatrix();
    svc = new SessionsService(store, matrix);
    // chat-service notify + any other network is stubbed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
  });

  it("openSession registers a Matrix user and assigns the least-completed condition", async () => {
    const res = await svc.openSession(open);
    expect(res.session.condition.id).toBe("public-neutral");
    expect(res.participantId).toBeTruthy();
    expect(res.matrix.accessToken).toMatch(/^tok/);
    expect(res.session.status).toBe("waiting"); // 1 of 3
    expect(res.matrix.roomId).toBe(""); // not provisioned yet
  });

  it("openSession can force a condition for pilot testing", async () => {
    const res = await svc.openSession({
      ...open,
      conditionId: "private-engaging",
    });
    expect(res.session.condition.id).toBe("private-engaging");
  });

  it("provisions the room once the group is full and notifies the chat service", async () => {
    const a = await svc.openSession(open);
    await svc.openSession(open);
    const c = await svc.openSession(open);

    expect(a.session.id).toBe(c.session.id); // filled the same forming session
    const session = await svc.getSession(a.session.id);
    expect(session.status).toBe("running");
    expect(session.roomId).toBe("!room:localhost");
    expect(matrix.createRoom).toHaveBeenCalledOnce();
    expect(matrix.joinRoom).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/internal/sessions/start"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("auto-off: assigns the next condition once one reaches its goal", async () => {
    const cond1 = (await store.listConditions())[0];
    for (let i = 0; i < 5; i++) {
      const session = await store.createForming(cond1);
      session.status = "completed";
      await store.saveSession(session);
    }
    const res = await svc.openSession(open);
    expect(res.session.condition.id).toBe("public-engaging");
  });

  it("throws ConflictException when the whole study is full", async () => {
    for (const cond of await store.listConditions()) {
      for (let i = 0; i < cond.goal; i++) {
        const session = await store.createForming(cond);
        session.status = "completed";
        await store.saveSession(session);
      }
    }
    await expect(svc.openSession(open)).rejects.toThrow(/full/i);
  });

  it("getSession throws NotFound for an unknown id", async () => {
    await expect(svc.getSession("nope")).rejects.toThrow();
  });

  it("lists sessions and interventions for admin/debug views", async () => {
    const res = await svc.openSession(open);
    const summaries = await svc.listSessions();
    expect(summaries[0]).toMatchObject({
      id: res.session.id,
      conditionId: "public-neutral",
      participantCount: 1,
      interventionCount: 0,
    });

    const session = await svc.finalizeSession(res.session.id, [], [], [
      {
        id: "i1",
        sessionId: res.session.id,
        roomId: "!r",
        conditionId: "public-neutral",
        mode: "public-neutral",
        audience: "public",
        tone: "neutral",
        timestamp: "2026-01-01T00:00:00.000Z",
        trigger: "contribution-threshold",
        threshold: 0.4,
        contributionWindowMinutes: 4,
        contributionSplit: [],
        targets: [],
        quietMembers: [],
        message: "hi",
      },
    ]);
    expect(session.interventions).toHaveLength(1);
    expect((await svc.listInterventions())[0]).toMatchObject({
      sessionId: res.session.id,
      message: "hi",
    });
  });

  it("submitSurvey attaches entry and exit surveys to the participant", async () => {
    const res = await svc.openSession(open);
    await svc.submitSurvey({
      sessionId: res.session.id,
      participantId: res.participantId,
      kind: "entry",
      survey: { answers: { age: 30 }, submittedAt: "now" },
    });
    const participant = (await svc
      .getSession(res.session.id))
      .participants.find((p) => p.id === res.participantId);
    expect(participant?.entrySurvey?.answers.age).toBe(30);
  });

  it("finalizeSession stores messages + ranking history and completes", async () => {
    const res = await svc.openSession(open);
    const ranking: Ranking = {
      taskId: "expedition-mars",
      order: ["water", "oxygen"],
      updatedAt: "now",
      updatedBy: "u1",
    };
    const session = await svc.finalizeSession(
      res.session.id,
      [
        {
          id: "m1",
          timestamp: "now",
          senderId: "u1",
          recipientId: null,
          text: "hi",
          reactions: [],
        },
      ],
      [ranking],
    );
    expect(session.chat.messages).toHaveLength(1);
    expect(session.rankingHistory).toHaveLength(1);
    expect(session.interventions).toEqual([]);
    expect(session.ranking).toEqual(ranking); // final = last of history
    expect(session.status).toBe("completed");
  });

  it("completeSession is idempotent", async () => {
    const res = await svc.openSession(open);
    const first = await svc.completeSession(res.session.id);
    expect(first.status).toBe("completed");
    const second = await svc.completeSession(res.session.id);
    expect(second.completedAt).toBe(first.completedAt);
  });

  it("exports sessions as JSON bundle and CSV summary", async () => {
    await svc.openSession(open);
    expect((await svc.exportBundle()).sessions).toHaveLength(1);
    expect((await svc.exportBundle(["private-neutral"])).sessions).toHaveLength(0);

    const csv = await svc.exportCsv();
    expect(csv).toContain("session_id,condition_id");
    expect(csv).toContain("public-neutral");
  });
});
