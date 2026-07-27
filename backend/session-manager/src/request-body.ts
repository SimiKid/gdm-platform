import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * Live-session checkpoints contain the full discussion, telemetry and LLM
 * audit records. Even an ordinary LLM-enabled session exceeds Express's
 * 100 KB default, so allow a bounded payload sized for a complete session.
 */
export const DEFAULT_SESSION_BODY_LIMIT = "10mb";

export function configureRequestBodyLimit(app: NestExpressApplication): void {
  const limit =
    process.env.SESSION_MANAGER_BODY_LIMIT?.trim() ||
    DEFAULT_SESSION_BODY_LIMIT;
  app.useBodyParser("json", { limit });
}
