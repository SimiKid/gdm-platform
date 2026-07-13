import { execSync } from "node:child_process";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

/**
 * Starts one throwaway Postgres for the whole integration run and applies the
 * real Prisma migrations, so tests exercise the exact production schema.
 * Test files receive the connection string via inject("databaseUrl").
 */
export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const databaseUrl = container.getConnectionUri();

  execSync("pnpm exec prisma migrate deploy --schema prisma/schema.prisma", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  project.provide("databaseUrl", databaseUrl);

  return async () => {
    await container.stop();
  };
}
