import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** Unauthenticated liveness probe for the container healthcheck. */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("health")
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /** Readiness verifies that the research database can execute a query. */
  @Get("health/ready")
  async ready(): Promise<{ status: "ok"; database: "ok" | "memory" }> {
    if (!process.env.DATABASE_URL) return { status: "ok", database: "memory" };
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: "ok", database: "ok" };
    } catch {
      throw new ServiceUnavailableException("Research database unavailable");
    }
  }
}
