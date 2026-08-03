import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_TOKEN, API, API_HEADERS } from "../support/e2e-helpers";

/**
 * The Results tab UI: descriptives table, round filter chips driving the
 * download links, the research-bundle download itself, and the Settings
 * rounds card's confirm step.
 *
 * Deliberately read-only against the shared stack: the start-round flow is
 * exercised only up to its confirm step and then cancelled (actually
 * starting a round would abort every waiting lobby other specs may be
 * forming — that behavior is covered by the session-manager integration
 * suite instead).
 */
test("@results the Results tab renders, filters by round, and serves the research bundle", async ({
  browser,
  request,
}) => {
  const roundsRes = await request.get(`${API}/rounds`, {
    headers: API_HEADERS,
  });
  expect(roundsRes.ok()).toBe(true);
  const rounds = (await roundsRes.json()) as {
    currentRound: number;
    rounds: Array<{ number: number }>;
  };

  const context = await browser.newContext();
  try {
    if (ADMIN_TOKEN) {
      await context.addInitScript(
        (token) => localStorage.setItem("gdm-admin-token", token),
        ADMIN_TOKEN,
      );
    }
    const page = await context.newPage();
    await page.goto(ADMIN);
    await expect(
      page.getByRole("heading", { name: "Study Admin" }),
    ).toBeVisible();

    await test.step("descriptives table and export sections render", async () => {
      await page.getByRole("button", { name: "Results" }).click();
      await expect(
        page.getByRole("heading", { name: "Results by Condition" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Research Exports" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Identifying Data" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Linkage (CSV, identifying)" }),
      ).toBeVisible();
    });

    await test.step("round chips rewrite every download link", async () => {
      test.skip(rounds.rounds.length < 2, "single-round stack: no chips");
      const bundle = page.getByRole("link", {
        name: "Research Bundle (ZIP + codebook)",
      });
      expect(await bundle.getAttribute("href")).not.toContain("roundIds");

      await page
        .getByRole("group", { name: "Round filter" })
        .getByRole("button", { name: `Round ${rounds.currentRound}` })
        .click();
      await expect(page.getByText(`Showing Round ${rounds.currentRound}.`)).toBeVisible();
      expect(await bundle.getAttribute("href")).toContain(
        `roundIds=${rounds.currentRound}`,
      );
      expect(
        await page
          .getByRole("link", { name: "Linkage (CSV, identifying)" })
          .getAttribute("href"),
      ).toContain(`roundIds=${rounds.currentRound}`);

      await page
        .getByRole("group", { name: "Round filter" })
        .getByRole("button", { name: "All rounds" })
        .click();
      await expect(page.getByText("Showing all rounds.")).toBeVisible();
      expect(await bundle.getAttribute("href")).not.toContain("roundIds");
    });

    await test.step("the research bundle downloads as a real zip", async () => {
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page
          .getByRole("link", { name: "Research Bundle (ZIP + codebook)" })
          .click(),
      ]);
      expect(download.suggestedFilename()).toBe("research_bundle.zip");
      const path = await download.path();
      expect(path).not.toBeNull();
    });

    await test.step("the Settings rounds card confirms before starting and can cancel", async () => {
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(
        page.getByRole("heading", { name: "Study Rounds" }),
      ).toBeVisible();
      const nextNumber = rounds.currentRound + 1;
      await page
        .getByRole("button", { name: `Start Round ${nextNumber}` })
        .click();
      // Two-step confirm: nothing has happened yet, and Cancel backs out.
      await expect(page.getByRole("button", { name: "Confirm" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(
        page.getByRole("button", { name: `Start Round ${nextNumber}` }),
      ).toBeVisible();

      const after = (
        await (
          await request.get(`${API}/rounds`, { headers: API_HEADERS })
        ).json()
      ) as { currentRound: number };
      expect(after.currentRound).toBe(rounds.currentRound); // unchanged
    });
  } finally {
    await context.close();
  }
});
