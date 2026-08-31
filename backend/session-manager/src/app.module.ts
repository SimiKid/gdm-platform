import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { HealthController } from "./health/health.controller";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { ReportsController } from "./reports/reports.controller";
import { ReportsService } from "./reports/reports.service";
import { RoundsController } from "./rounds/rounds.controller";
import { MatrixService } from "./matrix/matrix.service";
import { StoreService } from "./store/store.service";
import { PrismaService } from "./prisma/prisma.service";
import { AdminGuard } from "./auth/admin.guard";
import { InternalGuard } from "./auth/internal.guard";
import { ParticipantGuard } from "./auth/participant.guard";
import { ProlificActionsService } from "./prolific/prolific-actions.service";

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        // High enough for the validated 249-user recruitment burst and live
        // checkpoints, while still bounding anonymous HTTP floods.
        ttl: 60_000,
        limit: 6_000,
      },
    ]),
  ],
  controllers: [
    HealthController,
    SessionsController,
    ReportsController,
    RoundsController,
  ],
  providers: [
    SessionsService,
    ReportsService,
    MatrixService,
    PrismaService,
    StoreService,
    AdminGuard,
    InternalGuard,
    ParticipantGuard,
    ProlificActionsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
