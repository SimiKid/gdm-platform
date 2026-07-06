import { Module } from "@nestjs/common";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixBotService } from "./matrix/matrix-bot.service";
import { ContributionBotRules } from "./rules/bot-rules";
import { BOT_RULES } from "./rules/bot-rules.token";

@Module({
  controllers: [SessionsController],
  providers: [
    SessionsService,
    MatrixBotService,
    { provide: BOT_RULES, useClass: ContributionBotRules },
  ],
})
export class AppModule {}
