import { Module } from "@nestjs/common";
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

@Module({
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
  ],
})
export class AppModule {}
