import { describe, it, expect, vi } from "vitest";
import { SessionsController } from "./sessions.controller";
import type { SessionsService } from "./sessions.service";
import type { StoreService } from "../store/store.service";

describe("SessionsController", () => {
  const sessions = {
    openSession: vi.fn(async () => ({ session: { id: "s" } })),
    getSession: vi.fn(() => ({ id: "s" })),
    submitSurvey: vi.fn(),
    completeSession: vi.fn(() => ({ id: "s", status: "completed" })),
    finalizeSession: vi.fn(() => ({ id: "s" })),
  } as unknown as SessionsService;
  const store = {
    listConditions: () => [{ id: "c1", name: "C1", goal: 5 }],
    completedCount: () => 2,
  } as unknown as StoreService;
  const ctrl = new SessionsController(sessions, store);

  it("openSession delegates to the service", async () => {
    await ctrl.openSession({ trackingToken: "t", participantName: "" });
    expect(sessions.openSession).toHaveBeenCalled();
  });

  it("getSession delegates by id", () => {
    ctrl.getSession("s");
    expect(sessions.getSession).toHaveBeenCalledWith("s");
  });

  it("submitSurvey returns ok", () => {
    expect(
      ctrl.submitSurvey({
        sessionId: "s",
        participantId: "p",
        kind: "entry",
        survey: { answers: {}, submittedAt: "" },
      }),
    ).toEqual({ ok: true });
  });

  it("complete delegates by id", () => {
    ctrl.complete("s");
    expect(sessions.completeSession).toHaveBeenCalledWith("s");
  });

  it("finalize passes messages and ranking history", () => {
    ctrl.finalize("s", { messages: [], rankingHistory: [] });
    expect(sessions.finalizeSession).toHaveBeenCalledWith("s", [], []);
  });

  it("progress maps completed count and goal per condition", () => {
    const progress = ctrl.progress();
    expect(progress[0]).toMatchObject({ completed: 2, goal: 5 });
  });
});
