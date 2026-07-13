import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  closeGroup,
  createCondition,
  deactivateCondition,
  pollAdminSession,
  provisionGroup,
  sendChat,
  uniqueId,
  type ProvisionedGroup,
} from "../support/e2e-helpers";

const FIRST_MESSAGE = "Oxygen should stay at the top of our team ranking.";
const SECOND_MESSAGE = "Agreed, and water should remain close behind.";
const PARTICIPANT_IDENTITIES = ["Red", "Blue"];

test("@collaboration live feedback, reactions, ranking and telemetry work together", async ({
  browser,
  request,
}) => {
  const condition = await createCondition(request, {
    id: uniqueId("collaboration"),
    name: "E2E Collaboration",
    durationMinutes: 2,
    groupSize: 2,
    config: { interventionMode: "baseline", llmMode: "off" },
  });
  let group: ProvisionedGroup | undefined;

  try {
    group = await provisionGroup(browser, request, condition.id, condition.groupSize);
    const [author, observer] = group.members;
    const authorIdentity = identityFor(author.matrix.userId, group);

    await test.step("typing feedback is live and the message synchronizes", async () => {
      const input = author.page.getByPlaceholder("Type a message");
      await input.fill(FIRST_MESSAGE[0]);
      await expect(observer.page.locator(".typing-indicator")).toContainText(
        `${authorIdentity} is typing...`,
        { timeout: 20_000 },
      );
      // Keep typing beyond Matrix's four-second lease. The participant client
      // must renew it while input remains active.
      await input.pressSequentially(FIRST_MESSAGE.slice(1), { delay: 100 });
      await expect(observer.page.locator(".typing-indicator")).toContainText(
        `${authorIdentity} is typing...`,
      );
      await input.press("Enter");
      await Promise.all(
        group!.pages.map((page) =>
          expect(page.getByText(FIRST_MESSAGE, { exact: true })).toBeVisible({
            timeout: 30_000,
          }),
        ),
      );
      await sendChat(observer.page, SECOND_MESSAGE);
      await expect(author.page.getByText(SECOND_MESSAGE, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("the first-message picker opens below and reactions add, sync and remove", async () => {
      const message = observer.page.locator(".message", { hasText: FIRST_MESSAGE });
      await message.getByRole("button", { name: "Add reaction" }).click();
      const picker = message.locator(".emoji-picker.below");
      await expect(picker).toBeVisible();
      const [messageBox, pickerBox] = await Promise.all([
        message.boundingBox(),
        picker.boundingBox(),
      ]);
      expect(messageBox).not.toBeNull();
      expect(pickerBox).not.toBeNull();
      expect(pickerBox!.y).toBeGreaterThanOrEqual(
        messageBox!.y + messageBox!.height - 1,
      );

      await picker.getByRole("button", { name: "👍" }).click();
      await Promise.all(
        group!.pages.map((page) =>
          expect(reactionFor(page, FIRST_MESSAGE)).toHaveText("👍 1", {
            timeout: 30_000,
          }),
        ),
      );
      await pollAdminSession(request, group!.sessionId, (session) =>
        session.chat.messages.some(
          (item) =>
            item.text === FIRST_MESSAGE &&
            item.reactions.some((reaction) => reaction.key === "👍"),
        ),
      );

      await reactionFor(observer.page, FIRST_MESSAGE).click();
      await Promise.all(
        group!.pages.map((page) =>
          expect(reactionFor(page, FIRST_MESSAGE)).toHaveCount(0, {
            timeout: 30_000,
          }),
        ),
      );
      await pollAdminSession(
        request,
        group!.sessionId,
        (session) => {
          const item = session.chat.messages.find(
            (messageItem) => messageItem.text === FIRST_MESSAGE,
          );
          return Boolean(item) && item!.reactions.length === 0;
        },
      );
    });

    await test.step("remote ranking movement is identified and animated", async () => {
      const authorFirst = author.page.locator("ol.ranking-list .rank-label").first();
      const movedLabel = await authorFirst.innerText();
      const observerFirst = observer.page.locator("ol.ranking-list .rank-label").first();
      await author.page
        .locator("ol.ranking-list li")
        .first()
        .getByRole("button", { name: "Move down" })
        .click();
      await expect(observerFirst).not.toHaveText(movedLabel, { timeout: 30_000 });
      await expect(observer.page.locator(".ranking-activity")).toHaveText(
        `${authorIdentity} moved ${movedLabel} from #1 to #2`,
      );
      await expect(
        observer.page.locator("ol.ranking-list li.remote-move", {
          hasText: movedLabel,
        }),
      ).toBeVisible();
    });

    await test.step("keyboard resizing changes and persists the task-panel width", async () => {
      const panel = author.page.locator(".panel-col");
      const before = await elementWidth(panel);
      await author.page.getByRole("separator", { name: "Resize task panel" }).press(
        "ArrowLeft",
      );
      await expect
        .poll(() => elementWidth(panel), { timeout: 5_000 })
        .toBeGreaterThan(before);
      const stored = await author.page.evaluate(() =>
        Number(localStorage.getItem("gdm-panel-width")),
      );
      expect(stored).toBeGreaterThan(before);
      const resized = await elementWidth(panel);
      await author.page.reload();
      await expect(
        author.page.getByPlaceholder("Type a message"),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => elementWidth(author.page.locator(".panel-col")))
        .toBeCloseTo(resized, 0);
    });

    await test.step("typing, visibility, cursor and ranking behavior persist", async () => {
      await author.page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: false,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await author.page.mouse.move(20, 20);
      await author.page.mouse.move(220, 140);

      const detail = await pollAdminSession(
        request,
        group!.sessionId,
        (session) => {
          const authorEvents = session.behavioralEvents.filter(
            (event) => event.participantId === author.matrix.userId,
          );
          const types = new Set(authorEvents.map((event) => event.type));
          return [
            "typing-start",
            "typing-stop",
            "tab-hidden",
            "tab-visible",
            "cursor-activity",
            "ranking-move",
          ].every((type) => types.has(type));
        },
        25_000,
      );
      const cursor = detail.behavioralEvents.find(
        (event) =>
          event.participantId === author.matrix.userId &&
          event.type === "cursor-activity",
      );
      expect(Number(cursor?.payload?.sampleCount)).toBeGreaterThan(0);
      expect(Number(cursor?.payload?.distancePx)).toBeGreaterThan(0);
      expect(Number.isInteger(Number(cursor?.payload?.lastX))).toBe(true);
      expect(Number.isInteger(Number(cursor?.payload?.lastY))).toBe(true);
      const typingStop = detail.behavioralEvents.find(
        (event) =>
          event.participantId === author.matrix.userId &&
          event.type === "typing-stop",
      );
      expect(Number(typingStop?.durationMs)).toBeGreaterThan(0);
    });
  } finally {
    if (group) await closeGroup(group);
    await deactivateCondition(request, condition);
  }
});

function identityFor(userId: string, group: ProvisionedGroup): string {
  const participantIds = group.members
    .map((member) => member.matrix.userId)
    .sort();
  return PARTICIPANT_IDENTITIES[participantIds.indexOf(userId)];
}

function reactionFor(page: Page, messageText: string) {
  return page
    .locator(".message", { hasText: messageText })
    .locator("button.reaction");
}

async function elementWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}
