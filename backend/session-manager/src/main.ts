import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureRequestBodyLimit } from "./request-body";

/**
 * With GDM_ENV=production, an empty token silently disables the auth guards
 * and a localhost MATRIX_PUBLIC_URL gets handed to participant browsers —
 * refuse to start instead of running misconfigured.
 */
function assertProductionConfig() {
  if (process.env.GDM_ENV !== "production") return;
  const errors: string[] = [];
  if (!strongSecret(process.env.ADMIN_API_TOKEN)) {
    errors.push(
      "ADMIN_API_TOKEN must be a fresh secret of at least 32 characters",
    );
  }
  if (!strongSecret(process.env.INTERNAL_API_TOKEN)) {
    errors.push(
      "INTERNAL_API_TOKEN must be a fresh secret of at least 32 characters",
    );
  }
  if (
    !strongSecret(process.env.MATRIX_SERVICE_PASSWORD) ||
    process.env.MATRIX_SERVICE_PASSWORD === "gdm-dev-orchestrator-password"
  ) {
    errors.push(
      "MATRIX_SERVICE_PASSWORD must be a fresh secret of at least 32 characters",
    );
  }
  if (process.env.PROLIFIC_REQUIRE_VALIDATION === "true") {
    if (!process.env.PROLIFIC_STUDY_ID) {
      errors.push(
        "PROLIFIC_STUDY_ID is empty while Prolific validation is enabled",
      );
    }
    if (!process.env.PROLIFIC_API_TOKEN) {
      errors.push(
        "PROLIFIC_API_TOKEN is empty while Prolific validation is enabled",
      );
    }
  }
  if (
    process.env.PROLIFIC_PAYMENT_AUTOMATION === "true" &&
    !process.env.PROLIFIC_API_TOKEN
  ) {
    errors.push(
      "PROLIFIC_API_TOKEN is empty while Prolific payment automation is enabled",
    );
  }
  const matrixPublicUrl = process.env.MATRIX_PUBLIC_URL ?? "";
  if (!matrixPublicUrl || matrixPublicUrl.includes("localhost")) {
    errors.push(
      `MATRIX_PUBLIC_URL is "${matrixPublicUrl}" — participants' browsers need the public HTTPS URL`,
    );
  }
  if (errors.length > 0) {
    const logger = new Logger("Bootstrap");
    for (const error of errors) logger.error(error);
    logger.error("GDM_ENV=production requires the values above; fix infra/.env and restart.");
    process.exit(1);
  }
}

function strongSecret(value: string | undefined): boolean {
  return Boolean(value && value.trim().length >= 32);
}

async function bootstrap() {
  assertProductionConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.disable("x-powered-by");
  // Only Caddy/nginx can reach this container in production. Honour their
  // single forwarded hop so per-IP throttling keys on the real client.
  app.set("trust proxy", 1);
  configureRequestBodyLimit(app);
  // Production frontends and API are same-origin. Development may opt into a
  // short allowlist rather than reflecting arbitrary websites.
  if (process.env.GDM_ENV !== "production") {
    const origins = (
      process.env.CORS_ORIGINS ??
      "http://localhost:3000,http://localhost:3003,http://localhost:5173,http://localhost:5174,http://127.0.0.1:3000,http://127.0.0.1:3003,http://127.0.0.1:5173,http://127.0.0.1:5174"
    )
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
    app.enableCors({ origin: origins });
  }
  app.setGlobalPrefix("api");
  // Let in-flight checkpoint transactions finish before Prisma disconnects
  // during a container replacement.
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  new Logger("Bootstrap").log(`Session Manager listening on :${port}/api`);
}

void bootstrap();
