import { expect, test } from "@playwright/test";
import {
  closeGroup,
  createCondition,
  deactivateCondition,
  pollAdminSession,
  provisionGroup,
  sendChat,
  uniqueId,
} from "../support/e2e-helpers";

const LIVE_ENABLED = process.env.E2E_LIVE_ANTHROPIC === "1";
const EXPECTED_MODEL =
  process.env.E2E_EXPECTED_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

const MESSAGES = [
  "We should rank the oxygen tanks first because a crew cannot survive without breathable oxygen.",
  "Calibration phrase: purple rectangle, violin, tram 741.",
  "Calibration phrase: pineapple, notebook, window 902.",
] as const;

test("@shadow-live the deployed Anthropic classifier records an ignored contribution without nudging", async ({
  browser,
  request,
}) => {
  test.skip(
    !LIVE_ENABLED,
    "Set E2E_LIVE_ANTHROPIC=1 to make the intentional live Anthropic calls.",
  );
  test.setTimeout(120_000);

  const condition = await createCondition(request, {
    id: uniqueId("shadow-live"),
    name: "E2E Live Anthropic Shadow",
    groupSize: 2,
    durationMinutes: 2,
    config: {
      interventionMode: "baseline",
      contributionThreshold: 0.55,
      protectedStartMinutes: 0,
      protectedEndMinutes: 0,
      interventionWindowMinutes: 30,
      contributionWindowMinutes: 30,
      scoreWeights: { messages: 1, characters: 0.01 },
      llmMode: "shadow",
      ignoredGraceSeconds: 0,
      ignoredMinSubsequentMessages: 2,
    },
  });
  let group: Awaited<ReturnType<typeof provisionGroup>> | undefined;

  try {
    group = await provisionGroup(browser, request, condition.id, 2);

    // Poll after every message. Besides making external latency explicit, this
    // proves each Matrix event receives its own auditable API classification.
    await sendChat(group.pages[0], MESSAGES[0]);
    await pollAdminSession(
      request,
      group.sessionId,
      (session) => session.contributionClassifications.length >= 1,
      45_000,
    );
    await sendChat(group.pages[1], MESSAGES[1]);
    await pollAdminSession(
      request,
      group.sessionId,
      (session) => session.contributionClassifications.length >= 2,
      45_000,
    );
    await sendChat(group.pages[1], MESSAGES[2]);
    const detail = await pollAdminSession(
      request,
      group.sessionId,
      (session) =>
        session.contributionClassifications.length >= 3 &&
        session.contributionClassifications.some(
          (classification) => classification.ignoredInShadow === true,
        ) &&
        session.behavioralEvents.some(
          (event) => event.type === "llm-shadow-trigger",
        ),
      45_000,
    );

    expect(detail.contributionClassifications).toHaveLength(3);
    const recorded = new Map(
      detail.chat.messages.map((message, index) => [message.id, index]),
    );
    const firstMessage = detail.chat.messages.find(
      (message) => message.text === MESSAGES[0],
    );
    expect(firstMessage).toBeDefined();
    const first = detail.contributionClassifications.find(
      (classification) => classification.messageId === firstMessage!.id,
    );
    expect(first).toMatchObject({
      senderId: group.members[0].matrix.userId,
      substantive: true,
      ignoredInShadow: true,
      model: EXPECTED_MODEL,
      promptVersion: "ignored-contribution-v1",
    });
    expect(first!.relevanceWeight).toBeGreaterThanOrEqual(0);
    expect(first!.relevanceWeight).toBeLessThanOrEqual(2);

    for (const classification of detail.contributionClassifications) {
      expect(recorded.has(classification.messageId)).toBe(true);
      const messageIndex = recorded.get(classification.messageId)!;
      for (const reference of classification.references) {
        expect(recorded.has(reference)).toBe(true);
        expect(recorded.get(reference)!).toBeLessThan(messageIndex);
      }
      for (const member of group.members) {
        expect(classification.prompt).not.toContain(member.matrix.userId);
      }
      expect(classification.prompt).toContain(
        "Transcript (participants are pseudonymous):",
      );
      expect(classification.prompt).toMatch(/(?:Red|Blue):/);

      const raw = JSON.parse(classification.rawOutput) as Record<string, unknown>;
      expect(raw).toEqual({
        substantive: expect.any(Boolean),
        relevanceWeight: expect.any(Number),
        references: expect.any(Array),
        explanation: expect.any(String),
      });
    }

    const shadowEvents = detail.behavioralEvents.filter(
      (event) => event.type === "llm-shadow-trigger",
    );
    expect(shadowEvents).toHaveLength(1);
    expect(shadowEvents[0]).toMatchObject({
      participantId: group.members[0].matrix.userId,
      payload: {
        messageId: firstMessage!.id,
        subsequentMessages: 2,
      },
    });
    expect(detail.interventions).toEqual([]);
    await Promise.all(
      group.pages.map((page) => expect(page.locator(".bot-message")).toHaveCount(0)),
    );
  } finally {
    if (group) await closeGroup(group);
    await deactivateCondition(request, condition);
  }
});
