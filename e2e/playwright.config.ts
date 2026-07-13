import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the local docker-compose stack
 * (infra/start.sh). global-setup verifies the stack is up.
 *
 * Override the targets with E2E_PARTICIPANT_URL / E2E_SESSION_MANAGER_URL /
 * E2E_ADMIN_URL when the stack runs elsewhere.
 */
export default defineConfig({
  testDir: "./tests",
  globalSetup: "./global-setup.ts",
  // Matrix rooms and temporary conditions are shared server-side resources.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 300_000,
  expect: { timeout: 15_000 },
  // printSteps: each test.step() prints as it passes, so a run shows WHAT
  // was verified, not just one green line at the end.
  reporter: [["list", { printSteps: true }]],
  use: {
    baseURL: process.env.E2E_PARTICIPANT_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
