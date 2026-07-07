import { Controller, Get } from "@nestjs/common";

/** Unauthenticated liveness probe for the container healthcheck. */
@Controller()
export class HealthController {
  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }
}
