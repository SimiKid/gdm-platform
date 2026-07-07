import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

/**
 * Integration tests: the real chat-service Nest app (bot sync loop, rules)
 * against a real Synapse homeserver started via Testcontainers in
 * test/integration/global-setup. The Session Manager is a fake HTTP server.
 *
 * Run with: pnpm test:integration (requires Docker).
 */
export default defineConfig({
  // These boot the real Nest module graph, so DI needs decorator metadata —
  // SWC emits it, esbuild cannot.
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
    // All files share one homeserver; run them one after another.
    fileParallelism: false,
    // Tests wait on real Matrix sync round-trips and discussion timers.
    testTimeout: 60_000,
    // Synapse container start can take a while on a cold machine.
    hookTimeout: 180_000,
  },
});
