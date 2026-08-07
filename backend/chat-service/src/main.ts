import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

/**
 * With GDM_ENV=production, an empty INTERNAL_API_TOKEN silently disables the
 * auth guard between Session Manager and Chat Service — refuse to start
 * instead of running unprotected.
 */
function assertProductionConfig() {
  if (process.env.GDM_ENV !== "production") return;
  if (
    !process.env.INTERNAL_API_TOKEN ||
    process.env.INTERNAL_API_TOKEN.trim().length < 32
  ) {
    const logger = new Logger("Bootstrap");
    logger.error(
      "INTERNAL_API_TOKEN must be a fresh secret of at least 32 characters",
    );
    logger.error("GDM_ENV=production requires it; fix infra/.env and restart.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    const logger = new Logger("Bootstrap");
    logger.error(
      "GDM_ENV=production requires ANTHROPIC_API_KEY for generated nudges",
    );
    process.exit(1);
  }
}

async function bootstrap() {
  assertProductionConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port);
  new Logger("Bootstrap").log(`Chat Service listening on :${port}`);
}

void bootstrap();
