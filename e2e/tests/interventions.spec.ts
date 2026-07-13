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

const DOMINANT_MESSAGE =
  "Detailed proposal: rank the oxygen tanks first because the crew cannot survive without breathable oxygen while crossing the lunar surface.";
const FOLLOW_UP =
  "Additional detail: the oxygen supply also supports the pressurized suits throughout the journey.";

type InterventionMode =
  | "baseline"
  | "public-neutral"
  | "public-engaging"
  | "private-neutral"
  | "private-engaging";

const SCENARIOS: Array<{
  mode: Exclude<InterventionMode, "baseline">;
  audience: "public" | "private";
  tone: "neutral" | "engaging";
  text: string;
}> = [
  {
    mode: "public-neutral",
    audience: "public",
    tone: "neutral",
    text: "@all, consider this info",
  },
  {
    mode: "public-engaging",
    audience: "public",
    tone: "engaging",
    text: "you are the top contributor",
  },
  {
    mode: "private-neutral",
    audience: "private",
    tone: "neutral",
    text: "consider this info as you continue",
  },
  {
    mode: "private-engaging",
    audience: "private",
    tone: "engaging",
    text: "check in with group members",
  },
];

for (const scenario of SCENARIOS) {
  test(`@interventions ${scenario.mode} targets the correct audience and persists its audit record`, async ({
    browser,
    request,
  }) => {
    const condition = await createCondition(request, {
      id: uniqueId(`intervention-${scenario.mode}`),
      name: `E2E ${scenario.mode}`,
      groupSize: 2,
      durationMinutes: 1,
      config: {
        interventionMode: scenario.mode,
        contributionThreshold: 0.55,
        protectedStartMinutes: 0,
        protectedEndMinutes: 0,
        interventionWindowMinutes: 30,
        contributionWindowMinutes: 30,
        scoreWeights: { messages: 1, characters: 0.01 },
        llmMode: "off",
        ignoredGraceSeconds: 0,
        ignoredMinSubsequentMessages: 2,
      },
    });
    let group: Awaited<ReturnType<typeof provisionGroup>> | undefined;

    try {
      group = await provisionGroup(browser, request, condition.id, 2);
      const [target, observer] = group.pages;

      await sendChat(target, DOMINANT_MESSAGE);

      const targetNudge = target.locator(".bot-message", {
        hasText: scenario.text,
      });
      await expect(targetNudge).toHaveCount(1, { timeout: 30_000 });
      if (scenario.audience === "private") {
        await expect(targetNudge).toHaveClass(/private/);
        await expect(targetNudge.locator(".bot-label")).toContainText(
          "only you can see this",
        );
      } else {
        await expect(
          observer.locator(".bot-message", { hasText: scenario.text }),
        ).toHaveCount(1, { timeout: 30_000 });
      }

      // A second dominant message is inside the 30-minute cooldown. The
      // observer's message also gives private-event filtering time to settle.
      await sendChat(target, FOLLOW_UP);
      await sendChat(observer, "ok");
      await expect(
        observer.locator(".message .body", { hasText: FOLLOW_UP }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        target.locator(".message .body", { hasText: "ok" }),
      ).toBeVisible({ timeout: 30_000 });

      if (scenario.audience === "private") {
        await expect(observer.locator(".bot-message")).toHaveCount(0);
      } else {
        await expect(observer.locator(".bot-message")).toHaveCount(1);
      }
      await expect(target.locator(".bot-message")).toHaveCount(1);

      const detail = await pollAdminSession(
        request,
        group.sessionId,
        (session) =>
          session.chat.messages.length >= 3 && session.interventions.length === 1,
        30_000,
      );
      const intervention = detail.interventions[0];
      expect(intervention).toMatchObject({
        sessionId: group.sessionId,
        conditionId: condition.id,
        mode: scenario.mode,
        audience: scenario.audience,
        tone: scenario.tone,
        trigger: "contribution-threshold",
        threshold: 0.55,
        contributionWindowMinutes: 30,
      });
      expect(intervention.targets).toEqual([
        expect.objectContaining({ userId: group.members[0].matrix.userId }),
      ]);
      expect(intervention.quietMembers).toEqual([
        expect.objectContaining({ userId: group.members[1].matrix.userId }),
      ]);
      expect(intervention.contributionSplit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: group.members[0].matrix.userId,
            share: 1,
          }),
          expect.objectContaining({
            userId: group.members[1].matrix.userId,
            share: 0,
          }),
        ]),
      );
      expect(detail.contributionClassifications).toEqual([]);
      expect(detail.chat.messages.map((message) => message.text)).toEqual(
        expect.arrayContaining([DOMINANT_MESSAGE, FOLLOW_UP, "ok"]),
      );
      expect(
        detail.chat.messages.some((message) =>
          message.text.includes(scenario.text),
        ),
      ).toBe(false);
    } finally {
      if (group) await closeGroup(group);
      await deactivateCondition(request, condition);
    }
  });
}
