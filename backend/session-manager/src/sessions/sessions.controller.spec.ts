import { describe, it, expect, vi } from "vitest";
import { SessionsController } from "./sessions.controller";
import type { SessionsService } from "./sessions.service";
import type { StoreService } from "../store/store.service";

describe("SessionsController", () => {
  const sessions = {
    openSession: vi.fn(async () => ({ session: { id: "s" } })),
    listSessions: vi.fn(async () => [{ id: "s" }]),
    getSession: vi.fn(async () => ({ id: "s" })),
    getPublicSession: vi.fn(async () => ({ id: "s" })),
    listInterventions: vi.fn(async () => [{ sessionId: "s" }]),
    exportBundle: vi.fn(async () => ({ generatedAt: "now", sessions: [] })),
    exportCsv: vi.fn(async () => "session_id\n"),
    exportMessages: vi.fn(async () => ({ generatedAt: "now", messages: [] })),
    exportMessagesCsv: vi.fn(async () => "message_id\n"),
    exportInterventions: vi.fn(async () => ({ generatedAt: "now", interventions: [] })),
    exportInterventionsCsv: vi.fn(async () => "mode\n"),
    exportSurveys: vi.fn(async () => ({ generatedAt: "now", surveys: [] })),
    exportSurveysCsv: vi.fn(async () => "kind\n"),
    submitSurvey: vi.fn(async () => undefined),
    completeSession: vi.fn(async () => ({ id: "s", status: "completed" })),
    finalizeSession: vi.fn(async () => ({ id: "s" })),
  } as unknown as SessionsService;
  const store = {
    listConditions: async () => [{ id: "c1", name: "C1", goal: 5 }],
    upsertCondition: vi.fn(async (condition) => condition),
    completedCount: async () => 2,
  } as unknown as StoreService;
  const ctrl = new SessionsController(sessions, store);

  it("openSession delegates to the service", async () => {
    await ctrl.openSession({ trackingToken: "t", participantName: "" });
    expect(sessions.openSession).toHaveBeenCalled();
  });

  it("getSession returns the sanitized participant view", async () => {
    await ctrl.getSession("s");
    expect(sessions.getPublicSession).toHaveBeenCalledWith("s");
    expect(sessions.getSession).not.toHaveBeenCalled();
  });

  it("getSessionFull (admin) returns the full session", async () => {
    await ctrl.getSessionFull("s");
    expect(sessions.getSession).toHaveBeenCalledWith("s");
  });

  it("listSessions delegates to the service", async () => {
    await expect(ctrl.listSessions()).resolves.toEqual([{ id: "s" }]);
  });

  it("submitSurvey returns ok", async () => {
    await expect(
      ctrl.submitSurvey({
        sessionId: "s",
        participantId: "p",
        kind: "entry",
        survey: { answers: {}, submittedAt: "" },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("complete delegates by id", async () => {
    await ctrl.complete("s");
    expect(sessions.completeSession).toHaveBeenCalledWith("s");
  });

  it("finalize passes messages and ranking history", async () => {
    await ctrl.finalize("s", { messages: [], rankingHistory: [] });
    expect(sessions.finalizeSession).toHaveBeenCalledWith("s", [], [], []);
  });

  it("progress maps completed count and goal per condition", async () => {
    const progress = await ctrl.progress();
    expect(progress[0]).toMatchObject({ completed: 2, goal: 5 });
  });

  it("upsertCondition updates through the store", async () => {
    const condition = {
      id: "c1",
      name: "C1",
      active: true,
      goal: 5,
      durationMinutes: 10,
      groupSize: 3,
      config: {
        interventionMode: "public-neutral",
        contributionThreshold: 0.4,
        protectedStartMinutes: 3,
        protectedEndMinutes: 2,
        interventionWindowMinutes: 4,
        contributionWindowMinutes: 4,
        scoreWeights: { messages: 1, characters: 0.01 },
      },
    } as const;
    await expect(ctrl.upsertCondition("c1", { condition })).resolves.toMatchObject({
      id: "c1",
    });
    expect(store.upsertCondition).toHaveBeenCalledWith(condition);
  });

  it("lists intervention summaries", async () => {
    await expect(ctrl.interventions()).resolves.toEqual([{ sessionId: "s" }]);
  });

  it("exports JSON and CSV with optional condition filters", async () => {
    await expect(ctrl.exportSessions("public-neutral,public-engaging")).resolves.toEqual({
      generatedAt: "now",
      sessions: [],
    });
    expect(sessions.exportBundle).toHaveBeenCalledWith([
      "public-neutral",
      "public-engaging",
    ]);

    await expect(ctrl.exportSessionsCsv("public-neutral")).resolves.toBe("session_id\n");
    expect(sessions.exportCsv).toHaveBeenCalledWith(["public-neutral"]);
  });

  it("exports chat logs, nudge events, and surveys per data set", async () => {
    await ctrl.exportMessages("public-neutral");
    expect(sessions.exportMessages).toHaveBeenCalledWith(["public-neutral"]);
    await expect(ctrl.exportMessagesCsv(undefined)).resolves.toBe("message_id\n");
    expect(sessions.exportMessagesCsv).toHaveBeenCalledWith([]);

    await ctrl.exportInterventions(undefined);
    expect(sessions.exportInterventions).toHaveBeenCalledWith([]);
    await expect(ctrl.exportInterventionsCsv("private-engaging")).resolves.toBe("mode\n");
    expect(sessions.exportInterventionsCsv).toHaveBeenCalledWith(["private-engaging"]);

    await ctrl.exportSurveys(undefined);
    expect(sessions.exportSurveys).toHaveBeenCalledWith([]);
    await expect(ctrl.exportSurveysCsv(undefined)).resolves.toBe("kind\n");
    expect(sessions.exportSurveysCsv).toHaveBeenCalledWith([]);
  });
});
