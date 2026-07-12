import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixBotService } from "./matrix/matrix-bot.service";
import { ContributionBotRules } from "./rules/bot-rules";
import { BOT_RULES } from "./rules/bot-rules.token";
import { InternalGuard } from "./auth/internal.guard";
import { AnthropicContributionClassifier } from "./classifier/anthropic-contribution-classifier";
import { CONTRIBUTION_CLASSIFIER } from "./classifier/contribution-classifier.token";

@Module({
  controllers: [HealthController, SessionsController],
  providers: [
    SessionsService,
    MatrixBotService,
    AnthropicContributionClassifier,
    {
      provide: CONTRIBUTION_CLASSIFIER,
      useExisting: AnthropicContributionClassifier,
    },
    { provide: BOT_RULES, useClass: ContributionBotRules },
    InternalGuard,
  ],
})
export class AppModule {}
