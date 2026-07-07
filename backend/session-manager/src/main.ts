import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

/**
 * With GDM_ENV=production, an empty token silently disables the auth guards
 * and a localhost MATRIX_PUBLIC_URL gets handed to participant browsers —
 * refuse to start instead of running misconfigured.
 */
function assertProductionConfig() {
  if (process.env.GDM_ENV !== "production") return;
  const errors: string[] = [];
  if (!process.env.ADMIN_API_TOKEN) {
    errors.push("ADMIN_API_TOKEN is empty — researcher endpoints would be unprotected");
  }
  if (!process.env.INTERNAL_API_TOKEN) {
    errors.push("INTERNAL_API_TOKEN is empty — internal endpoints would be unprotected");
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

async function bootstrap() {
  assertProductionConfig();
  const app = await NestFactory.create(AppModule);
  // Dev: the Vite frontend runs on a different origin.
  app.enableCors();
  app.setGlobalPrefix("api");
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  new Logger("Bootstrap").log(`Session Manager listening on :${port}/api`);
}

void bootstrap();
