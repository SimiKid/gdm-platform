import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API = process.env.E2E_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
const ADMIN = process.env.E2E_ADMIN_URL ?? "http://localhost:3003";

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

const CHAT_MESSAGES = [
  "I would put the oxygen tanks first, no question.",
  "Water second for me, you dehydrate fast up there.",
  "Do not forget the star map, we need to navigate.",
];

test.beforeAll(async ({ request }) => {
  await upsertCondition(request, true);
});

test.afterAll(async ({ request }) => {
  // Keep the data for inspection but stop matchmaking from picking the arm up.
  await upsertCondition(request, false);
});

async function upsertCondition(request: APIRequestContext, active: boolean) {
  const res = await request.put(`${API}/conditions/${CONDITION_ID}`, {
    data: {
      condition: {
        id: CONDITION_ID,
        name: "E2E Golden Path",
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
  await page.goto(`/?conditionId=${CONDITION_ID}`);
  await page.getByRole("button", { name: "Start" }).click();

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

  // Individual ranking: add all 15 items in list order, then submit.
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

test("three participants run a full study session end to end", async ({
  browser,
  request,
}) => {
  const startedAt = new Date().toISOString();

  // ── Three isolated participants walk in ─────────────────────────
  const pages: Page[] = [];
  for (let seat = 0; seat < GROUP_SIZE; seat++) {
    pages.push(await (await browser.newContext()).newPage());
  }
  await Promise.all(pages.map((page, seat) => walkToWaitingRoom(page, seat)));

  // The third join provisions the Matrix room; everyone lands in the chat.
  await Promise.all(
    pages.map((page) =>
      expect(page.getByPlaceholder("Type a message")).toBeVisible({
        timeout: 60_000,
      }),
    ),
  );

  // ── Live discussion over real Matrix ─────────────────────────────
  for (const [seat, page] of pages.entries()) {
    await page.getByPlaceholder("Type a message").fill(CHAT_MESSAGES[seat]);
    await page.keyboard.press("Enter");
  }
  // Everyone sees everyone's messages (round-trip through Synapse).
  await Promise.all(
    pages.map((page) =>
      Promise.all(
        CHAT_MESSAGES.map((text) =>
          expect(page.getByText(text)).toBeVisible({ timeout: 30_000 }),
        ),
      ),
    ),
  );

  // One participant edits the shared ranking; the edit syncs to the others.
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

  // ── Timer runs out → exit survey → debriefing ────────────────────
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
      await expect(page.getByRole("link", { name: "Claim compensation" })).toBeVisible();
    }),
  );

  // ── The research record is complete ──────────────────────────────
  const sessions = (await (await request.get(`${API}/sessions`)).json()) as Array<{
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
  await expect
    .poll(async () => {
      const res = await request.get(`${API}/sessions/${session!.id}`);
      return ((await res.json()) as { status: string }).status;
    })
    .toBe("completed");

  const detail = (await (
    await request.get(`${API}/sessions/${session!.id}`)
  ).json()) as {
    participants: unknown[];
    chat: { messages: { text: string }[] };
    rankingHistory?: unknown[];
  };
  expect(detail.participants).toHaveLength(GROUP_SIZE);
  const recordedTexts = detail.chat.messages.map((m) => m.text);
  for (const text of CHAT_MESSAGES) expect(recordedTexts).toContain(text);
  expect(detail.rankingHistory?.length ?? 0).toBeGreaterThanOrEqual(1);

  const surveys = (await (
    await request.get(`${API}/export/surveys?conditionIds=${CONDITION_ID}`)
  ).json()) as { surveys: { sessionId: string; kind: string }[] };
  const ours = surveys.surveys.filter((s) => s.sessionId === session!.id);
  expect(ours.filter((s) => s.kind === "entry")).toHaveLength(GROUP_SIZE);
  expect(ours.filter((s) => s.kind === "exit")).toHaveLength(GROUP_SIZE);

  // ── The researcher sees it in the dashboard ──────────────────────
  const admin = await (await browser.newContext()).newPage();
  await admin.goto(ADMIN);
  await expect(admin.getByRole("heading", { name: "Study Admin" })).toBeVisible();
  const row = admin.locator("tr", { hasText: session!.id.slice(0, 8) });
  await expect(row.locator(".status")).toHaveText("completed", { timeout: 20_000 });
});
