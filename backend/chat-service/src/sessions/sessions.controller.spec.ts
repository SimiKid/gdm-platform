import { describe, it, expect, vi } from "vitest";
import { SessionsController } from "./sessions.controller";
import type { SessionsService } from "./sessions.service";
import type { MatrixBotService } from "../matrix/matrix-bot.service";
import type { Condition } from "@gdm/shared";

const bot = { botUserId: "@bot:localhost" } as unknown as MatrixBotService;

describe("SessionsController (chat-service)", () => {
  it("start delegates to the service and returns ok", async () => {
    const sessions = {
      startSession: vi.fn(async () => undefined),
    } as unknown as SessionsService;
    const ctrl = new SessionsController(sessions, bot);
    const res = await ctrl.start({
      sessionId: "s",
      roomId: "!r",
      condition: {} as Condition,
      durationMinutes: 10,
    });
    expect(res).toEqual({ ok: true });
    expect(sessions.startSession).toHaveBeenCalled();
  });

  it("exposes the bot's Matrix user for room invites", () => {
    const ctrl = new SessionsController({} as SessionsService, bot);
    expect(ctrl.botIdentity()).toEqual({ userId: "@bot:localhost" });
  });
});
