import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.spec.{ts,tsx}"],
    // Multi-page userEvent flows under jsdom + coverage instrumentation run
    // 5-10x slower on the shared CI runner (all packages test in parallel)
    // than locally; the default 5 s limit flaked there.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.spec.{ts,tsx}",
        "src/main.tsx",
        "src/test-setup.ts",
        "src/vite-env.d.ts",
        // Owned by the Playwright e2e suite: App wires the whole study flow
        // together and WaitingRoom boots a real Matrix client against
        // Synapse; DinoGame is a canvas/requestAnimationFrame loop with no
        // study logic. None of them can be exercised meaningfully in jsdom.
        "src/App.tsx",
        "src/components/WaitingRoom.tsx",
        "src/components/DinoGame.tsx",
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
