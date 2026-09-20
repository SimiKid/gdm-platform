import { expect, test } from "@playwright/test";
import { ADMIN, ADMIN_TOKEN, API, API_HEADERS } from "../support/e2e-helpers";

/**
 * Research exports are URL-only (there is no Results tab): the bundle must
 * be served as a real zip under its documented filename, and the round
 * filter must be honoured on the URL. The Settings rounds card's two-step
 * confirm is checked in the same run.
 *
 * Deliberately read-only against the shared stack: the start-round flow is
 * exercised only up to its confirm step and then cancelled (actually
 * starting a round would abort every waiting lobby other specs may be
 * forming — that behavior is covered by the session-manager integration
 * suite instead).
 */
test("@exports the research bundle downloads by URL and the rounds card confirms before starting", async ({
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

  await test.step("the research bundle downloads as a real zip", async () => {
    const res = await request.get(`${API}/export/research.zip`, {
      headers: API_HEADERS,
    });
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("application/zip");
    expect(res.headers()["content-disposition"]).toContain("research_bundle.zip");
    const body = await res.body();
    // Local file header signature of a zip archive.
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  await test.step("the round filter is honoured on export URLs", async () => {
    const filtered = await request.get(
      `${API}/export/linkage.csv?roundIds=${rounds.currentRound}`,
      { headers: API_HEADERS },
    );
    expect(filtered.ok()).toBe(true);
    const lines = (await filtered.text()).trim().split("\n");
    const header = lines[0].split(",");
    const roundColumn = header.indexOf("round");
    expect(roundColumn).toBeGreaterThanOrEqual(0);
    for (const line of lines.slice(1)) {
      expect(line.split(",")[roundColumn]).toBe(String(rounds.currentRound));
    }
  });

  const context = await browser.newContext();
  try {
    if (ADMIN_TOKEN) {
      await context.addInitScript(
        (token) => sessionStorage.setItem("gdm-admin-token", token),
        ADMIN_TOKEN,
      );
    }
    const page = await context.newPage();
    await page.goto(ADMIN);
    await expect(
      page.getByRole("heading", { name: "Study Admin" }),
    ).toBeVisible();

    await test.step("the dashboard has no Results tab", async () => {
      await expect(page.getByRole("button", { name: "Results" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Overview" })).toBeVisible();
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
