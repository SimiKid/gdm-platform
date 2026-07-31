import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  ADMIN,
  ADMIN_TOKEN,
  API,
  API_HEADERS,
  closeGroup,
  createCondition,
  deactivateCondition,
  pollAdminSession,
  provisionGroup,
  sendChat,
  uniqueId,
} from "../support/e2e-helpers";

const DATASETS = [
  {
    path: "sessions",
    jsonFilename: "detailed_data.json",
    csvFilename: "overview.csv",
    arrays: ["sessions"],
  },
  {
    path: "messages",
    jsonFilename: "messages.json",
    csvFilename: "messages.csv",
    arrays: ["messages"],
  },
  {
    path: "interventions",
    jsonFilename: "interventions.json",
    csvFilename: "interventions.csv",
    arrays: ["interventions"],
  },
  {
    path: "surveys",
    jsonFilename: "surveys.json",
    csvFilename: "surveys.csv",
    arrays: ["surveys"],
  },
  {
    path: "contributions",
    jsonFilename: "contributions.json",
    csvFilename: "contributions.csv",
    arrays: ["contributions", "behavioralEvents", "classifications"],
  },
  {
    path: "participants",
    jsonFilename: "participants.json",
    csvFilename: "participants.csv",
    arrays: ["participants"],
  },
  {
    path: "sessions-analysis",
    jsonFilename: "sessions_analysis.json",
    csvFilename: "sessions_analysis.csv",
    arrays: ["sessions"],
  },
  {
    path: "windows",
    jsonFilename: "windows.json",
    csvFilename: "windows.csv",
    arrays: ["windows"],
  },
] as const;

test("@exports every researcher export is downloadable, authenticated and excludes automated sessions", async ({
  browser,
  request,
}) => {
  const condition = await createCondition(request, {
    id: uniqueId("exports"),
    name: "E2E Export Isolation",
    groupSize: 2,
    durationMinutes: 2,
    config: { interventionMode: "baseline", llmMode: "off" },
  });
  let group: Awaited<ReturnType<typeof provisionGroup>> | undefined;

  try {
    group = await provisionGroup(browser, request, condition.id, 2);
    await sendChat(group.pages[0], "E2E export isolation marker");
    await pollAdminSession(
      request,
      group.sessionId,
      (session) =>
        session.chat.messages.some(
          (message) => message.text === "E2E export isolation marker",
        ),
    );

    await test.step("all JSON and CSV APIs have stable metadata and filter e2e-* data", async () => {
      for (const dataset of DATASETS) {
        const query = `conditionIds=${encodeURIComponent(condition.id)}`;
        const jsonResponse = await request.get(
          `${API}/export/${dataset.path}?${query}`,
          { headers: API_HEADERS },
        );
        expect(jsonResponse.ok()).toBe(true);
        expect(jsonResponse.headers()["content-type"]).toContain(
          "application/json",
        );
        expect(jsonResponse.headers()["content-disposition"]).toContain(
          `filename="${dataset.jsonFilename}"`,
        );
        const body = (await jsonResponse.json()) as Record<string, unknown>;
        expect(Number.isNaN(Date.parse(String(body.generatedAt)))).toBe(false);
        for (const key of dataset.arrays) expect(body[key]).toEqual([]);
        expect(JSON.stringify(body)).not.toContain(condition.id);
        expect(JSON.stringify(body)).not.toContain(group!.sessionId);

        const csvResponse = await request.get(
          `${API}/export/${dataset.path}.csv?${query}`,
          { headers: API_HEADERS },
        );
        expect(csvResponse.ok()).toBe(true);
        expect(csvResponse.headers()["content-type"]).toContain("text/csv");
        expect(csvResponse.headers()["content-disposition"]).toContain(
          `filename="${dataset.csvFilename}"`,
        );
        const csv = await csvResponse.text();
        expect(csv.trim().split("\n")[0].length).toBeGreaterThan(5);
        expect(csv).not.toContain(condition.id);
        expect(csv).not.toContain(group!.sessionId);
      }
    });

    await test.step("linkage.csv and the research bundle are guarded and e2e-isolated", async () => {
      const query = `conditionIds=${encodeURIComponent(condition.id)}`;
      const linkage = await request.get(
        `${API}/export/linkage.csv?${query}`,
        { headers: API_HEADERS },
      );
      expect(linkage.ok()).toBe(true);
      expect(linkage.headers()["content-type"]).toContain("text/csv");
      expect(linkage.headers()["content-disposition"]).toContain(
        'filename="linkage.csv"',
      );
      expect(await linkage.text()).not.toContain(group!.sessionId);

      const zip = await request.get(`${API}/export/research.zip?${query}`, {
        headers: API_HEADERS,
      });
      expect(zip.ok()).toBe(true);
      expect(zip.headers()["content-type"]).toContain("application/zip");
      expect(zip.headers()["content-disposition"]).toContain(
        'filename="research_bundle.zip"',
      );
      const zipBody = await zip.body();
      expect(zipBody.subarray(0, 2).toString()).toBe("PK");
      expect(zipBody.toString("latin1")).toContain("codebook.md");

      if (ADMIN_TOKEN) {
        expect((await fetch(`${API}/export/linkage.csv`)).status).toBe(401);
        expect((await fetch(`${API}/export/research.zip`)).status).toBe(401);
        expect((await fetch(`${API}/reports/summary`)).status).toBe(401);
      }
    });

    await test.step("the admin download link returns a real file with the same isolation", async () => {
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
        const [download] = await Promise.all([
          page.waitForEvent("download"),
          page.getByRole("link", { name: "Full Data (JSON)" }).click(),
        ]);
        expect(download.suggestedFilename()).toBe("detailed_data.json");
        const path = await download.path();
        expect(path).not.toBeNull();
        const downloaded = JSON.parse(await readFile(path!, "utf8")) as {
          generatedAt: string;
          sessions: Array<{ id: string; condition: { id: string } }>;
        };
        expect(Number.isNaN(Date.parse(downloaded.generatedAt))).toBe(false);
        expect(
          downloaded.sessions.some(
            (session) =>
              session.id === group!.sessionId ||
              session.condition.id === condition.id,
          ),
        ).toBe(false);
      } finally {
        await context.close();
      }
    });

    await test.step("the protected admin record remains available for test inspection", async () => {
      const response = await request.get(
        `${API}/admin/sessions/${group!.sessionId}`,
        { headers: API_HEADERS },
      );
      expect(response.ok()).toBe(true);
      expect(((await response.json()) as { id: string }).id).toBe(
        group!.sessionId,
      );

      if (ADMIN_TOKEN) {
        expect((await fetch(`${API}/sessions`)).status).toBe(401);
        expect(
          (
            await fetch(`${API}/sessions`, {
              headers: { "x-admin-token": "e2e-intentionally-wrong" },
            })
          ).status,
        ).toBe(401);
      }
    });
  } finally {
    if (group) await closeGroup(group);
    await deactivateCondition(request, condition);
  }
});
