import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import type { StartSessionNotification } from "@gdm/shared";
import { SessionsService } from "./sessions.service";
import { MatrixBotService } from "../matrix/matrix-bot.service";
import { InternalGuard } from "../auth/internal.guard";

@Controller("internal")
@UseGuards(InternalGuard)
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly bot: MatrixBotService,
  ) {}

  /** Called by the Session Manager when a group's room is provisioned. */
  @Post("sessions/start")
  async start(
    @Body() body: StartSessionNotification,
  ): Promise<{ ok: true }> {
    await this.sessions.startSession(body);
    return { ok: true };
  }

  /**
   * The Matrix user the bot runs as. The Session Manager invites this user
   * into freshly-provisioned (invite-only) study rooms.
   */
  @Get("bot")
  botIdentity(): { userId: string } {
    return { userId: this.bot.botUserId };
  }
}
