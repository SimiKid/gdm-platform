import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { MatrixBotService } from "../matrix/matrix-bot.service";

/** Unauthenticated liveness probe for the container healthcheck. */
@Controller()
export class HealthController {
  constructor(private readonly bot: MatrixBotService) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness means the recorder bot is registered and its sync loop is live. */
  @Get("health/ready")
  ready(): { status: "ok"; matrix: "ok" } {
    if (!this.bot.isReady) {
      throw new ServiceUnavailableException("Matrix bot unavailable");
    }
    return { status: "ok", matrix: "ok" };
  }
}
