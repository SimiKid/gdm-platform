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

// Each message exercises different graded dimensions:
// [0] opens with a task item + stance (high relevance, nothing to cohere with),
// [1] replies and invites participation (high coherence),
// [2] is calibration noise that should score near zero.
const MESSAGES = [
  "We should rank the oxygen tanks first because a crew cannot survive without breathable oxygen.",
  "I agree with you that the oxygen tanks belong at the top. What would you put second?",
  "Calibration phrase: purple rectangle, violin, tram 741.",
] as const;

test("@llm-live the deployed Anthropic classifier records graded meaningfulness ratings without nudging", async ({
  browser,
  request,
}) => {
  test.skip(
    !LIVE_ENABLED,
    "Set E2E_LIVE_ANTHROPIC=1 to make the intentional live Anthropic calls.",
  );
  test.setTimeout(120_000);

  const condition = await createCondition(request, {
    id: uniqueId("llm-live"),
    name: "E2E Live Anthropic Classifier",
    groupSize: 2,
    durationMinutes: 2,
    config: {
      interventionMode: "baseline",
      contributionThreshold: 0.55,
      protectedStartMinutes: 0,
      protectedEndMinutes: 0,
      contributionWindowMinutes: 30,
      scoreWeights: { messages: 1, words: 0.05 },
      llmMode: "active",
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
      (session) => session.contributionClassifications.length >= 3,
      45_000,
    );

    expect(detail.contributionClassifications).toHaveLength(3);
    const byText = (text: string) => {
      const message = detail.chat.messages.find((item) => item.text === text);
      expect(message).toBeDefined();
      const classification = detail.contributionClassifications.find(
        (item) => item.messageId === message!.id,
      );
      expect(classification).toBeDefined();
      return classification!;
    };

    const opener = byText(MESSAGES[0]);
    expect(opener.senderId).toBe(group.members[0].matrix.userId);
    expect(opener.relevance.rating).toBeGreaterThanOrEqual(4);
    expect(opener.invitesParticipation.value).toBe(false);

    const reply = byText(MESSAGES[1]);
    expect(reply.coherence.rating).toBeGreaterThanOrEqual(4);
    expect(reply.invitesParticipation.value).toBe(true);

    const noise = byText(MESSAGES[2]);
    expect(noise.relevance.rating).toBeLessThanOrEqual(2);
    expect(noise.meaningfulnessScore).toBeLessThanOrEqual(0.25);

    for (const classification of detail.contributionClassifications) {
      expect(classification).toMatchObject({
        model: EXPECTED_MODEL,
        promptVersion: "meaningfulness-v2",
      });
      for (const member of group.members) {
        expect(classification.prompt).not.toContain(member.matrix.userId);
      }
      expect(classification.prompt).toContain("MESSAGE TO CLASSIFY:");
      expect(classification.prompt).toContain("TASK ITEMS:");
      expect(classification.prompt).toContain("GROUP MEMBERS:");
      expect(classification.prompt).toMatch(/Sender: (?:Red|Blue)/);

      const ratingShape = { rating: expect.any(Number), reason: expect.any(String) };
      const indicatorShape = { value: expect.any(Boolean), reason: expect.any(String) };
      const raw = JSON.parse(classification.rawOutput) as Record<string, unknown>;
      expect(raw).toEqual({
        relevance: ratingShape,
        coherence: ratingShape,
        invites_participation: indicatorShape,
      });

      for (const dimension of [classification.relevance, classification.coherence]) {
        expect(Number.isInteger(dimension.rating)).toBe(true);
        expect(dimension.rating).toBeGreaterThanOrEqual(1);
        expect(dimension.rating).toBeLessThanOrEqual(5);
      }
      const mean = (classification.relevance.rating + classification.coherence.rating) / 2;
      expect(classification.meaningfulnessScore).toBeCloseTo((mean - 1) / 4);
    }

    expect(detail.interventions).toEqual([]);
    await Promise.all(
      group.pages.map((page) => expect(page.locator(".bot-message")).toHaveCount(0)),
    );
  } finally {
    if (group) await closeGroup(group);
    await deactivateCondition(request, condition);
  }
});
