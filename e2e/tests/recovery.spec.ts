import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  API,
  API_HEADERS,
  closeGroup,
  createCondition,
  deactivateCondition,
  pollAdminSession,
  provisionGroup,
  sendChat,
  uniqueId,
} from "../support/e2e-helpers";

const RESTART_ENABLED = process.env.E2E_ALLOW_SERVICE_RESTART === "1";
const CHAT_HEALTH =
  process.env.E2E_CHAT_SERVICE_URL ?? "http://localhost:3002/health";
const DEFAULT_INFRA_DIR = existsSync(resolve(process.cwd(), "../infra"))
  ? resolve(process.cwd(), "../infra")
  : resolve(process.cwd(), "infra");

test("@recovery live messages, ranking and intervention state survive service restarts", async ({
  browser,
  request,
}) => {
  test.skip(
    !RESTART_ENABLED,
    "Set E2E_ALLOW_SERVICE_RESTART=1 on an isolated local stack to restart services.",
  );
  test.setTimeout(180_000);

  const apiHost = new URL(API).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(apiHost)) {
    throw new Error(
      `Recovery automation only controls a local compose stack (API is ${API}).`,
    );
  }

  const sessionsResponse = await request.get(`${API}/sessions`, {
    headers: API_HEADERS,
  });
  expect(sessionsResponse.ok()).toBe(true);
  const openRealSessions = (
    (await sessionsResponse.json()) as Array<{
      id: string;
      status: string;
      conditionId: string;
    }>
  ).filter(
    (session) =>
      ["waiting", "running"].includes(session.status) &&
      !session.conditionId.startsWith("e2e-"),
  );
  expect(
    openRealSessions,
    "Refusing to restart services while a real participant session is open",
  ).toEqual([]);

  const infraDir = process.env.E2E_COMPOSE_DIR ?? DEFAULT_INFRA_DIR;
  const composeEnvFile = process.env.E2E_COMPOSE_ENV_FILE ?? ".env";
  if (!existsSync(resolve(infraDir, composeEnvFile))) {
    throw new Error(
      `Recovery test needs ${resolve(infraDir, composeEnvFile)} and the local compose stack.`,
    );
  }

  const condition = await createCondition(request, {
    id: uniqueId("recovery"),
    name: "E2E Restart Recovery",
    groupSize: 2,
    // Enough time for a nudge, a controlled restart, and a second nudge.
    durationMinutes: 3,
    config: {
      interventionMode: "public",
      contributionThreshold: 0.55,
      protectedStartMinutes: 0,
      protectedEndMinutes: 0,
      // 15s windows: nudges follow within one boundary of each marker.
      contributionWindowMinutes: 0.25,
      scoreWeights: { messages: 1, words: 0.05 },
      llmMode: "off",
    },
  });
  let group: Awaited<ReturnType<typeof provisionGroup>> | undefined;
  let servicesStopped = false;
  const beforeText = "Recovery marker before the controlled restart.";
  const afterText = "Recovery marker after restart with another detailed proposal.";

  try {
    group = await provisionGroup(browser, request, condition.id, 2);
    await sendChat(group.pages[0], beforeText);
    await expect(group.pages[0].locator(".bot-message")).toHaveCount(1, {
      timeout: 30_000,
    });
    await group.pages[0]
      .locator("ol.ranking-list li")
      .first()
      .getByRole("button", { name: "Move down" })
      .click();

    const before = await pollAdminSession(
      request,
      group.sessionId,
      (session) =>
        session.chat.messages.some((message) => message.text === beforeText) &&
        (session.rankingHistory?.length ?? 0) >= 1 &&
        session.interventions.length === 1,
    );
    const beforeMessageId = before.chat.messages.find(
      (message) => message.text === beforeText,
    )!.id;

    compose(infraDir, composeEnvFile, [
      "stop",
      "chat-service",
      "session-manager",
    ]);
    servicesStopped = true;
    compose(infraDir, composeEnvFile, ["start", "session-manager"]);
    await waitForHealth(`${API}/health`, 60_000);
    compose(infraDir, composeEnvFile, ["start", "chat-service"]);
    await waitForHealth(CHAT_HEALTH, 60_000);
    servicesStopped = false;

    // The post-restart message draws a nudge at the next window boundary
    // (the recovered service re-arms the window timer from startedAt) —
    // proving the rule engine picked the recovered session back up.
    await sendChat(group.pages[0], afterText);
    const recovered = await pollAdminSession(
      request,
      group.sessionId,
      (session) =>
        session.chat.messages.filter((message) => message.text === afterText)
          .length === 1 && session.interventions.length === 2,
      30_000,
    );

    expect(
      recovered.chat.messages.filter((message) => message.text === beforeText),
    ).toHaveLength(1);
    expect(
      recovered.chat.messages.filter((message) => message.text === afterText),
    ).toHaveLength(1);
    expect(
      recovered.chat.messages.find((message) => message.text === beforeText)?.id,
    ).toBe(beforeMessageId);
    expect(recovered.rankingHistory?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(recovered.interventions).toHaveLength(2);
    expect(recovered.interventions[0].id).toBe(before.interventions[0].id);
    expect(new Set(recovered.processedEventIds ?? []).size).toBe(
      recovered.processedEventIds?.length ?? 0,
    );
    await expect(group.pages[0].locator(".bot-message")).toHaveCount(2);
  } finally {
    if (servicesStopped) {
      compose(infraDir, composeEnvFile, ["start", "session-manager"]);
      await waitForHealth(`${API}/health`, 60_000).catch(() => undefined);
      compose(infraDir, composeEnvFile, ["start", "chat-service"]);
      await waitForHealth(CHAT_HEALTH, 60_000).catch(() => undefined);
    }
    if (group) await closeGroup(group);
    await deactivateCondition(request, condition);
  }
});

function compose(infraDir: string, envFile: string, args: string[]): void {
  execFileSync(
    "docker",
    ["compose", "--env-file", envFile, ...args],
    { cwd: infraDir, stdio: "inherit", timeout: 90_000 },
  );
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Health check ${url} did not recover: ${lastError}`);
}
