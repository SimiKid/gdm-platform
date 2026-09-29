import { expect, test, type Browser, type Page } from "@playwright/test";
import { PERSONAS, lineFor } from "../support/discussion-script";
import { rankAllItems, walkToWaitingRoom } from "../support/e2e-helpers";

/**
 * Real-study simulation: N independent participants open the public study
 * link at the same time and go through the actual flow — intro, consent,
 * entry survey, individual ranking, waiting room, the full group discussion
 * (talking on a script until the timer ends), exit survey and debrief.
 *
 * No admin API, no test condition: matchmaking assigns the real active arms,
 * exactly as it would for recruited participants. The sessions therefore
 * COUNT toward the study (round progress, exports) — start a new round or
 * exclude them afterwards.
 *
 * Participants react to a bot nudge they can see: the person who was
 * dominating (persona 0) goes quiet and invites the others, quiet people
 * speak up right away and keep a faster pace, so the before/after effect is
 * visible in the session inspector.
 *
 *   E2E_REAL_STUDY=1 E2E_REAL_USERS=10 E2E_REAL_MINUTES=15 \
 *   E2E_PARTICIPANT_URL=https://gdmproject.ifi.uzh.ch \
 *   pnpm --dir e2e exec playwright test tests/real-study.spec.ts
 */
const ENABLED = process.env.E2E_REAL_STUDY === "1";
const USERS = Number(process.env.E2E_REAL_USERS ?? 10);
/** Expected discussion length, only used to size timeouts and pacing. */
const MINUTES = Number(process.env.E2E_REAL_MINUTES ?? 15);
const WAITING_ROOM_MS = 8 * 60_000;
const PACE = Math.max(1, MINUTES / 3);

interface Outcome {
  seat: number;
  result: string;
  messages: number;
  nudgesSeen: number;
}

test("@real-study participants take the real study concurrently and react to nudges", async ({
  browser,
}) => {
  test.skip(!ENABLED, "Set E2E_REAL_STUDY=1 to run the real-study simulation.");
  test.setTimeout((MINUTES * 60 + 25 * 60) * 1_000);

  const outcomes = await Promise.all(
    Array.from({ length: USERS }, (_, seat) => runParticipant(browser, seat)),
  );
  for (const o of outcomes) {
    console.log(
      `seat ${o.seat + 1} (persona ${(o.seat % PERSONAS.length) + 1}): ${o.result} · ${o.messages} messages · ${o.nudgesSeen} nudges seen`,
    );
  }
  expect(outcomes.filter((o) => o.result === "completed").length).toBeGreaterThan(0);
});

async function runParticipant(browser: Browser, seat: number): Promise<Outcome> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const persona = PERSONAS[seat % PERSONAS.length];
  const dominant = seat % PERSONAS.length === 0;
  let messages = 0;
  let nudgesSeen = 0;
  try {
    // Stagger arrivals over ~20 s so it looks like real traffic.
    await page.waitForTimeout(seat * 2_000);
    // No conditionId: matchmaking assigns the real active arms. Answers vary
    // a little per seat; different seats rank from different pool positions.
    await walkToWaitingRoom(page, {
      entry: {
        age: 22 + seat,
        gender: seat % 2 ? "Woman" : "Man",
        degree: seat % 3 ? "Bachelor's degree" : "Master's degree",
        // "moderately" exists on both the 5-point AI and 7-point personality scales.
        scale: seat % 2 ? /: Agree moderately$/i : /: Disagree moderately$/i,
      },
      rankingSeat: seat,
    });

    // Either the group forms and the chat opens, or the lobby times out.
    const chatInput = page.getByPlaceholder("Type a message");
    const ended = page.getByRole("heading", { name: "Your participation has ended" });
    await expect(chatInput.or(ended)).toBeVisible({ timeout: WAITING_ROOM_MS });
    if (!(await chatInput.isVisible())) {
      return { seat, result: "unmatched (lobby ended)", messages, nudgesSeen };
    }

    const exitSurvey = page.getByRole("heading", { name: "Final Task Reflection (1/3)" });
    const botMessages = page.locator(".bot-message");
    const say = async (text: string): Promise<boolean> => {
      try {
        await chatInput.fill(text);
        await chatInput.press("Enter");
        await expect(page.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 });
        messages += 1;
        return true;
      } catch (err) {
        if (!(await exitSurvey.isVisible())) {
          console.warn(`seat ${seat + 1} could not send: ${String(err).slice(0, 120)}`);
        }
        return false;
      }
    };

    let paceFactor = 1;
    let quietUntil = 0;
    await page.waitForTimeout(3_000 + (seat % 5) * 1_500);
    for (let i = 0; ; i += 1) {
      if (await exitSurvey.isVisible()) break;
      if (!(await chatInput.isVisible())) break;

      // React to a nudge that just appeared (public: everyone sees it;
      // private: only the target does).
      const seen = await botMessages.count();
      if (seen > nudgesSeen) {
        nudgesSeen = seen;
        if (dominant) {
          await say(persona.afterNudge[0]);
          quietUntil = Date.now() + 120_000; // step back for two minutes
          paceFactor = 3; // then stay noticeably slower
        } else {
          for (const text of persona.afterNudge) {
            await say(text);
            await page.waitForTimeout(6_000);
          }
          paceFactor = 0.5; // quiet people keep contributing more
        }
        continue;
      }

      if (Date.now() < quietUntil) {
        await page.waitForTimeout(5_000);
        continue;
      }

      await say(lineFor(persona, i));
      // Occasionally move an item in the shared ranking, like a real group.
      if (i % 4 === seat % 4) {
        await page
          .locator("ol.ranking-list li")
          .nth(seat % 3)
          .getByRole("button", { name: "Move down" })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
      }
      await page.waitForTimeout(persona.everyMs * PACE * paceFactor);
    }

    await expect(exitSurvey).toBeVisible({ timeout: (MINUTES + 3) * 60_000 });
    await finishExitFlow(page);
    return { seat, result: "completed", messages, nudgesSeen };
  } catch (err) {
    return { seat, result: `failed: ${String(err).slice(0, 200)}`, messages, nudgesSeen };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Exit survey (5-point scales) → debrief → finish. */
async function finishExitFlow(page: Page): Promise<void> {
  await rankAllItems(page, 0);
  await page.getByRole("button", { name: "Submit my final ranking" }).click();

  await page.getByRole("radio", { name: "Rather confident" }).check();
  for (const radio of await page.getByRole("radio", { name: /: Agree moderately$/i }).all()) await radio.check();
  await page.getByRole("button", { name: "Continue" }).click();

  for (const radio of await page.getByRole("radio", { name: /: Agree moderately$/i }).all()) await radio.check();
  await page.getByRole("button", { name: "Submit" }).click();

  await expect(page.getByRole("heading", { name: "Debrief" })).toBeVisible();
  const finish = page.getByRole("button", { name: "Finish study" });
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(page.getByText("Your participation is complete. You may close this tab.")).toBeVisible();
}
