import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
// ADMIN_TOKEN (E2E_ADMIN_TOKEN) is required when the target stack sets
// ADMIN_API_TOKEN (production smoke test); locally the guards are open.
import {
  ADMIN,
  ADMIN_TOKEN,
  API,
  API_HEADERS,
  rankAllItems,
  walkToWaitingRoom,
} from "../support/e2e-helpers";

/**
 * The test provisions its own condition so it never touches the study's real
 * arms: baseline mode (no bot nudges to race against) and a one-minute
 * discussion so the timer fires within the test run. Whole minutes only —
 * the research DB stores durationMinutes as an integer and the session
 * manager rounds and clamps condition writes to 1–240, so a fraction would
 * silently run a different discussion length than intended.
 * The id is unique per run so stale waiting sessions from an aborted earlier
 * run can never soak up this run's participants.
 */
const CONDITION_ID = `e2e-${Date.now().toString(36)}`;
// Readable run time so accumulated runs are told apart in the dashboard's
// Testing tab. Computed once: the condition is upserted again to switch off.
const CONDITION_NAME = `E2E Golden Path · ${new Date().toLocaleString("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
})}`;
const DISCUSSION_MINUTES = 1;
const GROUP_SIZE = 3;
const TEST_PROLIFIC = (() => {
  if (process.env.E2E_FAKE_PROLIFIC !== "1") return undefined;
  // Match the identity returned by infra/local-mocks.cjs.
  const suffix = Date.now().toString(16).padStart(24, "0");
  return {
    participantId: suffix,
    studyId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    sessionId: suffix,
  };
})();

const CHAT_MESSAGES = [
  "I would put the oxygen tanks first, no question.",
  "Water second for me, you dehydrate fast up there.",
  "Do not forget the star map, we need to navigate.",
];

let restoreEmptyCompensationUrl = false;

test.beforeAll(async ({ request }) => {
  const settings = await request.get(`${API}/settings`, { headers: API_HEADERS });
  expect(settings.ok()).toBe(true);
  const current = (await settings.json()) as { compensationUrl?: string };
  if (!current.compensationUrl) {
    const configured = await request.put(`${API}/settings`, {
      headers: API_HEADERS,
      data: {
        settings: {
          compensationUrl:
            "https://app.prolific.com/submissions/complete?cc=E2ETEST",
        },
      },
    });
    expect(configured.ok()).toBe(true);
    restoreEmptyCompensationUrl = true;
  }
  await upsertCondition(request, true);
});

test.afterAll(async ({ request }) => {
  // Keep the data for inspection but stop matchmaking from picking the arm up.
  await upsertCondition(request, false);
  if (restoreEmptyCompensationUrl) {
    const restored = await request.put(`${API}/settings`, {
      headers: API_HEADERS,
      data: { settings: { compensationUrl: "" } },
    });
    expect(restored.ok()).toBe(true);
  }
});

async function upsertCondition(request: APIRequestContext, active: boolean) {
  const res = await request.put(`${API}/conditions/${CONDITION_ID}`, {
    headers: API_HEADERS,
    data: {
      condition: {
        id: CONDITION_ID,
        name: CONDITION_NAME,
        active,
        goal: 100,
        durationMinutes: DISCUSSION_MINUTES,
        groupSize: GROUP_SIZE,
        config: { interventionMode: "baseline" },
      },
    },
  });
  expect(res.ok()).toBe(true);
}

/** Seat 0 optionally arrives through a fake Prolific link (no Start button). */
async function joinWaitingRoom(page: Page, seat: number): Promise<void> {
  const prolific = seat === 0 ? TEST_PROLIFIC : undefined;
  await walkToWaitingRoom(page, {
    query: {
      conditionId: CONDITION_ID,
      ...(prolific
        ? {
            PROLIFIC_PID: prolific.participantId,
            STUDY_ID: prolific.studyId,
            SESSION_ID: prolific.sessionId,
          }
        : {}),
    },
    prolific: Boolean(prolific),
    entry: { age: 24 + seat },
  });
}

test("@golden three participants run a full study session end to end", async ({
  browser,
  request,
}) => {
  const startedAt = new Date().toISOString();
  const pages: Page[] = [];

  await test.step("3 participants pass consent, entry survey and individual ranking into the waiting room", async () => {
    for (let seat = 0; seat < GROUP_SIZE; seat++) {
      pages.push(await (await browser.newContext()).newPage());
    }
    await Promise.all(pages.map((page, seat) => joinWaitingRoom(page, seat)));
  });

  await test.step("the third join provisions the Matrix room — everyone lands in the chat", async () => {
    await Promise.all(
      pages.map((page) =>
        expect(page.getByPlaceholder("Type a message")).toBeVisible({
          timeout: 60_000,
        }),
      ),
    );
  });

  await test.step("chat messages round-trip through Synapse to every participant", async () => {
    for (const [seat, page] of pages.entries()) {
      await page.getByPlaceholder("Type a message").fill(CHAT_MESSAGES[seat]);
      await page.keyboard.press("Enter");
    }
    await Promise.all(
      pages.map((page) =>
        Promise.all(
          CHAT_MESSAGES.map((text) =>
            expect(page.getByText(text)).toBeVisible({ timeout: 30_000 }),
          ),
        ),
      ),
    );
  });

  await test.step("a shared-ranking edit syncs live to the other participants", async () => {
    const observedFirstItem = pages[1].locator("ol.ranking-list .rank-label").first();
    const firstItemBefore = await observedFirstItem.innerText();
    await pages[0]
      .locator("ol.ranking-list li")
      .first()
      .getByRole("button", { name: "Move down" })
      .click();
    await expect(observedFirstItem).not.toHaveText(firstItemBefore, {
      timeout: 30_000,
    });
  });

  await test.step("the discussion timer ends — all three finish the exit survey to debriefing", async () => {
    for (const page of pages) {
      await expect(
        page.getByRole("heading", { name: "Final Task Reflection (1/3)" }),
      ).toBeVisible({ timeout: 90_000 });
    }

    await Promise.all(
      pages.map(async (page, seat) => {
        // Step 1: final ranking
        await rankAllItems(page);
        await page.getByRole("button", { name: "Submit my final ranking" }).click();

        // Step 2: confidence + group dynamics matrix
        await page.getByRole("radio", { name: "Rather confident" }).check();
        for (const radio of await page
          .getByRole("radio", { name: /: Disagree strongly$/i })
          .all()) {
          await radio.check();
        }
        await page.getByRole("button", { name: "Continue" }).click();

        // Step 3: psych safety + bot perception matrices
        for (const radio of await page
          .getByRole("radio", { name: /: Disagree strongly$/i })
          .all()) {
          await radio.check();
        }
        await page.getByRole("button", { name: "Submit" }).click();

        // Debriefing: direct participants finish in place; the (optional)
        // Prolific seat gets the completion link instead. No acknowledgement
        // checkbox — both actions are available right away.
        await expect(
          page.getByRole("heading", { name: "Debrief" }),
        ).toBeVisible();
        const prolificSeat = seat === 0 && Boolean(TEST_PROLIFIC);
        if (prolificSeat) {
          await expect(page.getByRole("link", { name: "Return to Prolific" })).toBeVisible();
        } else {
          const finish = page.getByRole("button", { name: "Finish study" });
          await expect(finish).toBeEnabled();
          await finish.click();
          await expect(
            page.getByText("Your participation is complete. You may close this tab."),
          ).toBeVisible();
        }
      }),
    );
  });

  let sessionId = "";
  await test.step("the research record is complete and exports exclude E2E residue", async () => {
    const sessions = (await (
      await request.get(`${API}/sessions`, { headers: API_HEADERS })
    ).json()) as Array<{
      id: string;
      conditionId: string;
      status: string;
      createdAt: string;
      participantCount: number;
      messageCount: number;
      rankingEditCount: number;
    }>;
    const session = sessions.find(
      (s) => s.conditionId === CONDITION_ID && s.createdAt >= startedAt,
    );
    expect(session, "the run's session should be in the research record").toBeDefined();
    sessionId = session!.id;
    await expect
      .poll(async () => {
        const res = await request.get(`${API}/admin/sessions/${sessionId}`, {
          headers: API_HEADERS,
        });
        return ((await res.json()) as { status: string }).status;
      })
      .toBe("completed");

    const detail = (await (
      await request.get(`${API}/admin/sessions/${sessionId}`, {
        headers: API_HEADERS,
      })
    ).json()) as {
      participants: {
        entrySurvey?: unknown;
        exitSurvey?: unknown;
        prolific?: typeof TEST_PROLIFIC;
      }[];
      chat: { messages: { text: string }[] };
      rankingHistory?: unknown[];
    };
    expect(detail.participants).toHaveLength(GROUP_SIZE);
    expect(detail.participants.filter((p) => p.entrySurvey)).toHaveLength(
      GROUP_SIZE,
    );
    expect(detail.participants.filter((p) => p.exitSurvey)).toHaveLength(
      GROUP_SIZE,
    );
    if (TEST_PROLIFIC) {
      expect(detail.participants.some((p) =>
        p.prolific?.sessionId === TEST_PROLIFIC.sessionId
      )).toBe(true);
    }
    const recordedTexts = detail.chat.messages.map((m) => m.text);
    for (const text of CHAT_MESSAGES) expect(recordedTexts).toContain(text);
    expect(detail.rankingHistory?.length ?? 0).toBeGreaterThanOrEqual(1);

    // Production exports deliberately omit automated e2e-* conditions so
    // smoke-test records cannot contaminate the study analysis data.
    const surveys = (await (
      await request.get(`${API}/export/surveys?conditionIds=${CONDITION_ID}`, {
        headers: API_HEADERS,
      })
    ).json()) as { surveys: { sessionId: string; kind: string }[] };
    expect(surveys.surveys.some((s) => s.sessionId === sessionId)).toBe(false);
  });

  await test.step("the researcher sees the session as completed in the dashboard", async () => {
    const adminContext = await browser.newContext();
    if (ADMIN_TOKEN) {
      // Pre-seed the token the dashboard keeps in sessionStorage so the run
      // lands on the session table instead of the token gate.
      await adminContext.addInitScript(
        (token) => sessionStorage.setItem("gdm-admin-token", token),
        ADMIN_TOKEN,
      );
    }
    const admin = await adminContext.newPage();
    await admin.goto(ADMIN);
    await expect(admin.getByRole("heading", { name: "Study Admin" })).toBeVisible();
    // E2E sessions live in the Testing view (Overview shows study arms only),
    // behind its collapsed test history.
    await admin.getByRole("button", { name: "Testing" }).click();
    await admin.getByRole("button", { name: "Show test history" }).click();
    const row = admin.locator("tr", { hasText: sessionId.slice(0, 8) });
    await expect(row.locator(".status")).toHaveText("completed", { timeout: 20_000 });
  });
});
