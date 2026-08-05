import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { SessionsController } from "./sessions/sessions.controller";
import { SessionsService } from "./sessions/sessions.service";
import { MatrixBotService } from "./matrix/matrix-bot.service";
import { StudyBotRules } from "./rules/bot-rules";
import { BOT_RULES } from "./rules/bot-rules.token";
import { InternalGuard } from "./auth/internal.guard";
import { AnthropicContributionClassifier } from "./classifier/anthropic-contribution-classifier";
import { CONTRIBUTION_CLASSIFIER } from "./classifier/contribution-classifier.token";
import { AnthropicNudgeMessageGenerator } from "./nudge/anthropic-nudge-message-generator";
import { NUDGE_MESSAGE_GENERATOR } from "./nudge/nudge-message-generator.token";

@Module({
  controllers: [HealthController, SessionsController],
  providers: [
    SessionsService,
    MatrixBotService,
    AnthropicContributionClassifier,
    AnthropicNudgeMessageGenerator,
    {
      provide: CONTRIBUTION_CLASSIFIER,
      useExisting: AnthropicContributionClassifier,
    },
    {
      provide: NUDGE_MESSAGE_GENERATOR,
      useExisting: AnthropicNudgeMessageGenerator,
    },
    { provide: BOT_RULES, useClass: StudyBotRules },
    InternalGuard,
  ],
})
export class AppModule {}
