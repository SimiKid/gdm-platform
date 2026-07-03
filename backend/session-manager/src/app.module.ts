import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixService } from "./matrix/matrix.service";
import { StoreService } from "./store/store.service";

@Module({
  controllers: [SessionsController],
  providers: [SessionsService, MatrixService, StoreService],
})
export class AppModule {}
