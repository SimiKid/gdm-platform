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
   * The Matrix users the bots run as. The Session Manager invites them into
   * freshly-provisioned (invite-only) study rooms — the comparison bots only
   * for conditions with the two-bot test enabled.
   */
  @Get("bot")
  async botIdentity(): Promise<{ userId: string; comparisonUserIds: string[] }> {
    return {
      userId: this.bot.botUserId,
      comparisonUserIds: await this.bot.comparisonBotUserIds(),
    };
  }
}
