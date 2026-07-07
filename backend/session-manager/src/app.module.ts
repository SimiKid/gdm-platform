import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixService } from "./matrix/matrix.service";
import { StoreService } from "./store/store.service";
import { PrismaService } from "./prisma/prisma.service";
import { AdminGuard } from "./auth/admin.guard";
import { InternalGuard } from "./auth/internal.guard";

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    MatrixService,
    PrismaService,
    StoreService,
    AdminGuard,
    InternalGuard,
  ],
})
export class AppModule {}
