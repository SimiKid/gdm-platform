import { defineConfig } from "vitest/config";

export default defineConfig({
  // Force legacy (experimental) decorators so NestJS classes transform correctly.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/main.ts",
        "src/**/*.module.ts",
        "src/**/*.spec.ts",
        // The Prisma/Postgres paths are exercised for real by the
        // Testcontainers suite (pnpm test:integration), not these unit tests.
        "src/store/store.service.ts",
        "src/prisma/prisma.service.ts",
      ],
      reporter: ["text", "text-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
