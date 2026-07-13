import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.spec.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // Scoped to the unit-testable code. The Matrix-driven components
      // (Chat, WaitingRoom, App, SharedRanking, Login) are integration-level
      // and covered by the manual/e2e run, not these unit tests.
      include: [
        "src/study/**/*.ts",
        "src/components/Recruiting.tsx",
        "src/components/Survey.tsx",
        "src/components/ExitSurvey.tsx",
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
