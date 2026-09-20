import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { API, ADMIN, API_HEADERS, createCondition, deactivateCondition, participantHeaders, uniqueId } from "../support/e2e-helpers";

// This test changes the global study mode. Run explicitly against a local stack.
test.skip(process.env.E2E_ETHERPAD !== "1", "Set E2E_ETHERPAD=1 on the local mock stack");
test.use({ actionTimeout: 15000 });

const editor = (page: Page) => page.frameLocator("iframe.etherpad-frame").frameLocator('iframe[name="ace_outer"]').frameLocator('iframe[name="ace_inner"]').locator("#innerdocbody");
async function status(request: APIRequestContext) { return (await request.get(`${API}/admin/etherpad`, { headers: API_HEADERS })).json(); }
async function questionnaires(page: Page, conditionId: string) {
  await page.goto(`/?conditionId=${conditionId}`);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /continue to the consent form/i }).click();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Begin study" }).click();
  await page.locator("#about-age").fill("30");
  await page.getByRole("radio", { name: "Man", exact: true }).check();
  await page.getByRole("radio", { name: "Bachelor's degree" }).check();
  await page.getByRole("radio", { name: "Fluent (advanced)" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  for (const radio of await page.getByRole("radio", { name: /: Disagree strongly$/i }).all()) await radio.check();
  await page.getByRole("group", { name: /work in teams/ }).getByRole("radio", { name: "Sometimes" }).check();
  await page.getByRole("group", { name: /communicating via text chat/ }).getByRole("radio", { name: "Rather comfortable" }).check();
  await page.getByRole("group", { name: /spaceflight-related/ }).getByRole("radio", { name: "Rather unfamiliar" }).check();
  await page.getByRole("group", { name: /wilderness.*survival/i }).getByRole("radio", { name: "Rather unfamiliar" }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your initial response" })).toBeVisible();
  await expect(editor(page)).toBeVisible({ timeout: 30000 });
}

test("private entry/exit pads, shared capped text, exports and a draining switch", async ({ browser, request }) => {
  test.setTimeout(300000);
  expect(new URL(API).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  await expect.poll(async () => (await status(request)).state, { timeout: 30000 }).toBe("stopped");
  const condition = await createCondition(request, { groupSize: 2, durationMinutes: 1, config: { interventionMode: "baseline", llmMode: "off" } });
  const admin = await browser.newPage(); const pages = [await browser.newPage(), await browser.newPage()];
  const errors: string[] = [];
  pages.forEach(page => { page.on("pageerror", e => { if (!errors.includes(e.message)) { errors.push(e.message); console.error("Editor error:", e.message); } }); });
  try {
    const rankingToken = uniqueId("ranking-before-switch");
    expect((await (await request.post(`${API}/workspace/prepare`, { headers: participantHeaders(rankingToken) })).json()).mode).toBe("ranking");
    await admin.goto(ADMIN);
    await admin.getByRole("button", { name: "Settings", exact: true }).click();
    await admin.getByRole("switch", { name: "Enable Etherpad" }).check();
    await expect(admin.locator(".workspace-busy")).toBeVisible();
    await expect(admin.getByRole("button", { name: "Testing", exact: true })).toBeDisabled();
    await expect.poll(async () => (await status(request)).state, { timeout: 90000 }).toBe("ready");
    await Promise.all(pages.map(p => questionnaires(p, condition.id)));

    await test.step("blank private pads and a server-enforced 1,000-character limit", async () => {
      expect((await editor(pages[0]).innerText()).trim()).toBe("");
      await editor(pages[0]).fill("x".repeat(1000));
      await expect(pages[0].frameLocator("iframe.etherpad-frame").getByText("1000 / 1000 characters", { exact: true })).toBeVisible();
      await editor(pages[0]).press("Control+End"); await editor(pages[0]).press("Z");
      await expect(pages[0].frameLocator("iframe.etherpad-frame").getByRole("alert")).toContainText("Maximum 1,000 characters");
      await expect(editor(pages[0])).toHaveText("x".repeat(1000));
      expect((await editor(pages[1]).innerText()).trim()).toBe("");
      await editor(pages[0]).fill("Alice entry 🌕\nKeep this raw text.");
      await editor(pages[1]).fill("Bob entry: oxygen first.");
      await Promise.all(pages.map(p => p.getByRole("button", { name: "Submit my response" }).click()));
      await Promise.all(pages.map(p => expect(p.getByRole("heading", { name: "You are now ready to join the group discussion!" })).toBeVisible()));
      for (const page of pages) { await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Join chat" }).click(); }
    });

    await Promise.all(pages.map(p => expect(p.getByPlaceholder("Type a message")).toBeVisible({ timeout: 60000 })));
    await Promise.all(pages.map(p => expect(editor(p)).toBeVisible({ timeout: 30000 })));
    const token = await pages[0].evaluate(() => sessionStorage.getItem("gdm-tracking-token")!);
    const sessionId = await pages[0].evaluate(() => JSON.parse(sessionStorage.getItem("gdm-study-progress")!).sessionId);
    await test.step("a shared blank pad synchronizes while Matrix chat stays separate", async () => {
      expect((await editor(pages[0]).innerText()).trim()).toBe("");
      await editor(pages[0]).fill("Shared group response");
      await expect(editor(pages[1])).toHaveText("Shared group response");
      await editor(pages[0]).fill("x".repeat(990));
      await expect(editor(pages[1])).toHaveText("x".repeat(990));
      await Promise.all(pages.map(p => editor(p).press("Control+End")));
      await Promise.all(pages.map((p, i) => p.keyboard.insertText((i ? "B" : "A").repeat(10))));
      await expect.poll(async () => (await editor(pages[0]).innerText()).length).toBe(1000);
      await expect.poll(async () => (await editor(pages[1]).innerText()).length).toBe(1000);
      await expect.poll(async () => (await editor(pages[0]).innerText()) === (await editor(pages[1]).innerText())).toBe(true);
      await editor(pages[0]).fill("Shared group response");
      await expect(editor(pages[1])).toHaveText("Shared group response");
      await pages[0].getByPlaceholder("Type a message").fill("Chat transcript is separate from the pad.");
      await pages[0].getByPlaceholder("Type a message").press("Enter");
      await expect(pages[1].getByText("Chat transcript is separate from the pad.")).toBeVisible();
    });

    await admin.getByRole("switch", { name: "Enable Etherpad" }).uncheck();
    await expect.poll(async () => (await status(request)).state).toBe("draining");
    expect((await (await request.post(`${API}/workspace/prepare`, { headers: participantHeaders(uniqueId("ranking-after-switch")) })).json()).mode).toBe("ranking");
    await expect(editor(pages[0])).toBeVisible();
    await test.step("private exit pads start blank and save before advancing", async () => {
      for (const page of pages) {
        await expect(page.getByRole("heading", { name: "Your final response" })).toBeVisible({ timeout: 90000 });
        await expect(editor(page)).toBeVisible();
        expect((await editor(page).innerText()).trim()).toBe("");
      }
      await editor(pages[0]).fill("Alice final response"); await editor(pages[1]).fill("Bob final response");
      await Promise.all(pages.map(p => p.getByRole("button", { name: "Submit my response" }).click()));
      await expect.poll(async () => (await status(request)).state, { timeout: 30000 }).toBe("stopped");
    });

    // These calls read the persisted research snapshots with the editor stopped.
    const saved = [];
    for (const page of pages) {
      const ownToken = await page.evaluate(() => sessionStorage.getItem("gdm-tracking-token")!);
      for (const phase of ["entry", "exit"]) saved.push(await (await request.post(`${API}/workspace/pads/${phase}`, { headers: participantHeaders(ownToken), data: { sessionId } })).json());
    }
    saved.push(await (await request.post(`${API}/workspace/pads/group`, { headers: participantHeaders(token), data: { sessionId } })).json());
    expect(saved.map(p => p.text)).toEqual(expect.arrayContaining(["Alice entry 🌕\nKeep this raw text.", "Bob entry: oxygen first.", "Shared group response", "Alice final response", "Bob final response"]));
    expect(saved.every(p => p.state === "captured")).toBe(true);
    // Preserve the existing exclusion of automated test arms from research downloads.
    const exported = await (await request.get(`${API}/export/etherpad?conditionIds=${condition.id}`, { headers: API_HEADERS })).json();
    expect(exported.pads).toEqual([]);
    const rankings = await (await request.get(`${API}/export/rankings?conditionIds=${condition.id}`, { headers: API_HEADERS })).json();
    expect(rankings.rankings).toEqual([]);
    const analysis = await (await request.get(`${API}/export/sessions-analysis?conditionIds=${condition.id}`, { headers: API_HEADERS })).json();
    expect(analysis.sessions).toEqual([]);
    const pad = await (await request.post(`${API}/workspace/pads/entry`, { headers: participantHeaders(token) })).json();
    const unauthorized = await request.post(`${API}/workspace/finish/${pad.id}`, { headers: participantHeaders("stranger") });
    expect(unauthorized.status()).toBe(401);
    expect(errors).toEqual([]);
    expect(sessionId).toBeTruthy();
    // Verify another cold startup followed by an immediate stop with no active writers.
    await admin.getByRole("switch", { name: "Enable Etherpad" }).check();
    await expect.poll(async () => (await status(request)).state, { timeout: 90000 }).toBe("ready");
    await expect(admin.getByRole("switch", { name: "Enable Etherpad" })).toBeEnabled();
    await admin.getByRole("switch", { name: "Enable Etherpad" }).uncheck();
    await expect.poll(async () => (await status(request)).state, { timeout: 30000 }).toBe("stopped");
  } finally {
    for (const page of pages) {
      const token = await page.evaluate(() => sessionStorage.getItem("gdm-tracking-token")).catch(() => null);
      if (token) await request.post(`${API}/workspace/leave`, { headers: participantHeaders(token) });
    }
    await expect.poll(async () => ["starting", "stopping"].includes((await status(request)).state), { timeout: 95000 }).toBe(false);
    await request.put(`${API}/admin/etherpad`, { headers: API_HEADERS, data: { enabled: false } });
    await expect.poll(async () => ["starting", "stopping"].includes((await status(request)).state), { timeout: 30000 }).toBe(false);
    await deactivateCondition(request, condition.id);
    await Promise.all([admin, ...pages].map(p => p.context().close()));
  }
});
