import { Body, Controller, Post } from "@nestjs/common";
import type { StartSessionNotification } from "@gdm/shared";
import { SessionsService } from "./sessions.service";

@Controller("internal")
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** Called by the Session Manager when a group's room is provisioned. */
  @Post("sessions/start")
  async start(
    @Body() body: StartSessionNotification,
  ): Promise<{ ok: true }> {
    await this.sessions.startSession(body);
    return { ok: true };
  }
}
