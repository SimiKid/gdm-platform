import { describe, it, expect, vi } from "vitest";
import { SessionsController } from "./sessions.controller";
import type { SessionsService } from "./sessions.service";
import type { Condition } from "@gdm/shared";

describe("SessionsController (chat-service)", () => {
  it("start delegates to the service and returns ok", async () => {
    const sessions = {
      startSession: vi.fn(async () => undefined),
    } as unknown as SessionsService;
    const ctrl = new SessionsController(sessions);
    const res = await ctrl.start({
      sessionId: "s",
      roomId: "!r",
      condition: {} as Condition,
      durationMinutes: 10,
    });
    expect(res).toEqual({ ok: true });
    expect(sessions.startSession).toHaveBeenCalled();
  });
});
