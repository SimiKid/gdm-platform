import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = process.env.E2E_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:3003";
// Required when the target stack sets ADMIN_API_TOKEN (production smoke test);
// locally the guards are open and this stays empty.
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const API_HEADERS = ADMIN_TOKEN
  ? { Authorization: `Bearer ${ADMIN_TOKEN}` }
  : undefined;

/**
 * The test provisions its own condition so it never touches the study's real
 * arms: baseline mode (no bot nudges to race against) and a one-minute
 * discussion so the timer fires within the test run. Whole minutes only —
 * the research DB stores durationMinutes as an integer and would silently
 * truncate a fraction to 0 (instant session end, no client timer).
 * The id is unique per run so stale waiting sessions from an aborted earlier
 * run can never soak up this run's participants.
 */
const CONDITION_ID = `e2e-${Date.now().toString(36)}`;
const DISCUSSION_MINUTES = 1;
const GROUP_SIZE = 3;
const TEST_PROLIFIC = (() => {
  if (process.env.E2E_FAKE_PROLIFIC !== "1") return undefined;
  const suffix = Date.now().toString(36).padStart(23, "0").slice(-23);
  return {
    participantId: `p${suffix}`,
    studyId: `s${suffix}`,
    sessionId: `r${suffix}`,
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
        // Unique per run so accumulated test arms stay distinguishable in
        // the dashboard's "Test conditions" group.
        name: `E2E Golden Path (${CONDITION_ID.slice(4)})`,
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

/** Recruiting → consent → about-you → individual ranking → group intro. */
async function walkToWaitingRoom(page: Page, seat: number): Promise<void> {
  const query = new URLSearchParams({ conditionId: CONDITION_ID });
  if (seat === 0 && TEST_PROLIFIC) {
    query.set("PROLIFIC_PID", TEST_PROLIFIC.participantId);
    query.set("STUDY_ID", TEST_PROLIFIC.studyId);
    query.set("SESSION_ID", TEST_PROLIFIC.sessionId);
  }
  await page.goto(`/?${query.toString()}`);
  if (!(seat === 0 && TEST_PROLIFIC)) {
    await page.getByRole("button", { name: "Start" }).click();
  }

  // Consent: all three boxes, then begin.
  await expect(
    page.getByRole("heading", { name: "Welcome to the Group Decision-Making Study" }),
  ).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Begin study" }).click();

  // About you.
  await page.locator("#about-age").fill(String(24 + seat));
  await page.getByRole("radio", { name: "Prefer not to say" }).check();
  await page
    .locator("#about-education")
    .selectOption({ label: "Master's degree" });
  await page.locator("#about-field").fill("End-to-end testing");
  await page.getByRole("button", { name: "Continue" }).click();

  // Individual ranking: add every current task item in list order, then submit.
  await expect(
    page.getByRole("heading", { name: "Your Task: Survival on the Moon" }),
  ).toBeVisible();
  await rankAllItems(page);
  await page.getByRole("button", { name: "Submit my ranking" }).click();

  // Follow-up questions.
  await page.getByRole("radio", { name: "Fluent" }).check();
  await page
    .getByRole("group", { name: "How often do you work on tasks in teams?" })
    .getByRole("radio", { name: "Sometimes" })
    .check();
  await page
    .getByRole("group", { name: "How comfortable are you communicating via text chat?" })
    .getByRole("radio", { name: "5", exact: true })
    .check();
  await page
    .getByRole("group", { name: "How familiar are you with spaceflight or survival-related topics?" })
    .getByRole("radio", { name: "4", exact: true })
    .check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Group intro → waiting room.
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Join chat" }).click();
  await expect(page.getByRole("heading", { name: "Waiting room" })).toBeVisible();
}

/** Click every "Add … to the ranking" button until the pool is empty. */
async function rankAllItems(page: Page): Promise<void> {
  const addButtons = page.getByRole("button", { name: /^Add .* to the ranking$/ });
  while ((await addButtons.count()) > 0) {
    await addButtons.first().click();
  }
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
    await Promise.all(pages.map((page, seat) => walkToWaitingRoom(page, seat)));
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
        page.getByRole("heading", { name: "Almost done: A few final questions" }),
      ).toBeVisible({ timeout: 90_000 });
    }

    await Promise.all(
      pages.map(async (page) => {
        await rankAllItems(page);
        for (const [question, rating] of [
          ["How satisfied are you with the group's final ranking?", "6"],
          ["The group reached its decision fairly.", "5"],
          ["I felt my views were heard during the discussion.", "5"],
        ] as const) {
          await page
            .getByRole("group", { name: question })
            .getByRole("radio", { name: rating, exact: true })
            .check();
        }
        await page.getByRole("button", { name: "Submit" }).click();

        await expect(
          page.getByRole("heading", { name: "Thank you for participating!" }),
        ).toBeVisible();
        await page.getByRole("checkbox", { name: "I have read the debriefing." }).check();
        await expect(page.getByRole("link", { name: "Return to Prolific" })).toBeVisible();
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
    // E2E sessions live in the Testing view (Overview shows study arms only).
    await admin.getByRole("button", { name: "Testing" }).click();
    const row = admin.locator("tr", { hasText: sessionId.slice(0, 8) });
    await expect(row.locator(".status")).toHaveText("completed", { timeout: 20_000 });
  });
});
