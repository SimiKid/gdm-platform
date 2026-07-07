import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Integration tests: the real NestJS app over HTTP against a real Postgres
 * (started once per run via Testcontainers in test/integration/global-setup).
 * Only the external boundaries (Synapse, Chat Service) are faked.
 *
 * Run with: pnpm test:integration (requires Docker).
 */
export default defineConfig({
  // Unlike the unit tests (which construct services by hand), these boot the
  // real Nest module graph, so DI needs decorator metadata — SWC emits it,
  // esbuild cannot.
  esbuild: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022",
      },
      module: { type: "es6" },
    }),
  ],
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["test/integration/**/*.spec.ts"],
    globalSetup: ["./test/integration/global-setup.ts"],
    // All files share one database; run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    // Container start + migrate deploy can take a while on a cold machine.
    hookTimeout: 120_000,
  },
});
