import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixBotService } from "./matrix/matrix-bot.service";
import { NoopBotRules } from "./rules/bot-rules";
import { BOT_RULES } from "./rules/bot-rules.token";

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    MatrixBotService,
    // Swap NoopBotRules for the real rules implementation here.
    { provide: BOT_RULES, useClass: NoopBotRules },
  ],
})
export class AppModule {}
