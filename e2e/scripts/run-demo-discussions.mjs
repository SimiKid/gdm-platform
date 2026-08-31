/**
 * Demo data generator: drives 9 real browser participants through the FULL
 * study flow (consent → entry survey → individual ranking → chat → exit
 * survey → debriefing) as 3 parallel groups of 3, one per study arm:
 * baseline, public-llm, private-llm.
 *
 * Uses the real pilot links and the arms' REAL parameters (10-minute
 * discussion, 3-minute warm-up), so expect a total runtime of ~13 minutes.
 * Seat 0 in every group is deliberately dominant so the bot nudges in the
 * delivery arms. The three arms are activated for the run and their
 * recruiting switches restored afterwards.
 *
 *   cd e2e && node scripts/run-demo-discussions.mjs
 */
import { chromium } from "@playwright/test";

const API = process.env.E2E_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
const PARTICIPANT = process.env.E2E_PARTICIPANT_URL ?? "http://localhost:3000";
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN ?? "";
const HEADERS = {
  "Content-Type": "application/json",
  ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
};

const ARMS = ["baseline", "public-llm", "private-llm"];

/** Seat 0 dominates; seats 1 and 2 contribute occasionally. */
const DOMINANT_LINES = [
  "Okay team, let me lay out my full reasoning: oxygen has to be first because nothing else matters if we cannot breathe while crossing the surface.",
  "Water second in my view, dehydration on the lighted side would be brutal, and the stellar map third so we can actually navigate to the rendezvous point.",
  "I also think the food concentrate belongs in the top five, we need energy for a 320 km trek, and the FM receiver for contacting the mother ship.",
  "Hear me out on the pistols: they are nearly useless, there is nothing to defend against, so I would put them near the bottom with the matches.",
  "The matches are literally pointless, no oxygen in the atmosphere means no combustion, so they go last, I feel strongly about that.",
  "Let me also argue about the raft: the CO2 bottles could propel us across crevasses, so it is more useful than people think, maybe rank eight.",
  "And the parachute silk can shield us from solar radiation during the day, I would place it around seven, right after the first aid kit.",
  "Summing up my proposal: oxygen, water, map, food, radio in the top five, then first aid, silk, raft, flares, and the junk items at the bottom.",
];
const QUIET_LINES = [
  ["I agree oxygen goes first.", "What about the heater for the cold?", "Fine with the map at three.", "The flares could signal the mother ship though."],
  ["Water top three for me too.", "I would move the compass last, the moon has no magnetic field.", "Should the first aid kit be higher?", "Okay, works for me."],
];

/** Per-seat confidence value (1-5) for exit survey step 2. */
const EXIT_CONFIDENCE = {
  baseline: [3, 4, 2],
  "public-llm": [4, 5, 4],
  "private-llm": [5, 5, 4],
};

const log = (arm, msg) => console.log(`[${new Date().toISOString()}] [${arm}] ${msg}`);

async function api(path, init) {
  const res = await fetch(`${API}${path}`, { headers: HEADERS, ...init });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function walkToWaitingRoom(page, arm, seat) {
  await page.goto(`${PARTICIPANT}/?conditionId=${arm}`);
  await page.getByRole("button", { name: "Start" }).click();

  await page
    .getByRole("heading", { name: "Welcome to the Study" })
    .waitFor({ timeout: 20_000 });
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /continue to the consent form/i }).click();
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Begin study" }).click();

  await page.locator("#about-age").fill(String(21 + seat * 3 + ARMS.indexOf(arm)));
  await page.getByRole("radio", { name: "Man" }).check();
  await page.getByRole("radio", { name: "Bachelor's degree" }).check();
  await page.getByRole("radio", { name: "Fluent (advanced)" }).check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Attitudes & personality page: fill all matrix radios + single items.
  for (const radio of await page.getByRole("radio", { name: /: Disagree strongly$/i }).all()) {
    await radio.check();
  }
  await page
    .getByRole("group", { name: /work in teams/ })
    .getByRole("radio", { name: "Sometimes" })
    .check();
  await page
    .getByRole("group", { name: /communicating via text chat/ })
    .getByRole("radio", { name: "Rather comfortable" })
    .check();
  await page
    .getByRole("group", { name: /spaceflight-related/ })
    .getByRole("radio", { name: "Rather unfamiliar" })
    .check();
  await page
    .getByRole("group", { name: /wilderness.*survival/i })
    .getByRole("radio", { name: "Rather unfamiliar" })
    .check();
  await page.getByRole("button", { name: "Continue" }).click();

  // Individual ranking: each seat adds items in a different order so the
  // NASA error scores vary between participants.
  await page
    .getByRole("heading", { name: "Task: Survival on the Moon" })
    .waitFor({ timeout: 20_000 });
  const addButtons = page.getByRole("button", { name: /^Add .* to the ranking$/ });
  while ((await addButtons.count()) > 0) {
    const count = await addButtons.count();
    await addButtons.nth((seat * 2) % count).click();
  }
  await page.getByRole("button", { name: "Submit my ranking" }).click();

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Join chat" }).click();
}

/** Send messages (and the odd shared-ranking move) until the exit survey appears. */
async function chatPhase(page, arm, seat) {
  const exitHeading = page.getByRole("heading", { name: "Almost done!" });
  const lines = seat === 0 ? DOMINANT_LINES : QUIET_LINES[seat - 1];
  const cadence = seat === 0 ? 24_000 : 55_000;
  const deadline = Date.now() + 16 * 60_000;
  let i = 0;

  while (Date.now() < deadline) {
    if (await exitHeading.isVisible().catch(() => false)) return;
    const box = page.getByPlaceholder("Type a message");
    if (await box.isVisible().catch(() => false)) {
      try {
        await box.fill(lines[i % lines.length]);
        await page.keyboard.press("Enter");
        i += 1;
        // Occasional shared-ranking edits from the quieter members.
        if (seat !== 0 && i % 2 === 0) {
          const item = page.locator("ol.ranking-list li").nth(seat * 3);
          const move = item.getByRole("button", { name: "Move up" });
          if (await move.isVisible().catch(() => false)) {
            await move.click().catch(() => {});
          }
        }
      } catch {
        /* session probably just ended between checks */
      }
    }
    await page.waitForTimeout(cadence + Math.floor(Math.random() * 10_000));
  }
  throw new Error(`[${arm} seat ${seat}] exit survey never appeared`);
}

async function exitSurvey(page, confidence) {
  // Step 1: final ranking
  await page
    .getByRole("heading", { name: "Almost done!" })
    .waitFor({ timeout: 60_000 });
  const addButtons = page.getByRole("button", { name: /^Add .* to the ranking$/ });
  while ((await addButtons.count()) > 0) await addButtons.first().click();
  await page.getByRole("button", { name: "Submit my final ranking" }).click();

  // Step 2: confidence + group dynamics matrix
  const confidenceLabels = [
    "Not confident at all",
    "Rather not confident",
    "Neither",
    "Rather confident",
    "Very confident",
  ];
  await page
    .getByRole("radio", { name: confidenceLabels[confidence - 1] })
    .check();
  // Group dynamics — click "Disagree strongly" for all 6 rows
  for (const radio of await page
    .getByRole("radio", { name: /: Disagree strongly$/i })
    .all()) {
    await radio.check();
  }
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: psych safety + bot perception — click "Disagree strongly" for all rows
  for (const radio of await page
    .getByRole("radio", { name: /: Disagree strongly$/i })
    .all()) {
    await radio.check();
  }
  await page.getByRole("button", { name: "Submit" }).click();

  await page
    .getByRole("heading", { name: "Debrief" })
    .waitFor({ timeout: 20_000 });
}

async function runGroup(browser, arm) {
  const contexts = [];
  try {
    const pages = [];
    for (let seat = 0; seat < 3; seat++) {
      const context = await browser.newContext();
      contexts.push(context);
      pages.push(await context.newPage());
    }
    log(arm, "onboarding 3 participants…");
    await Promise.all(pages.map((page, seat) => walkToWaitingRoom(page, arm, seat)));
    await Promise.all(
      pages.map((page) =>
        page.getByPlaceholder("Type a message").waitFor({ timeout: 120_000 }),
      ),
    );
    log(arm, "room provisioned, 10-minute discussion running…");
    await Promise.all(pages.map((page, seat) => chatPhase(page, arm, seat)));
    log(arm, "discussion over, filling exit surveys…");
    await Promise.all(
      pages.map((page, seat) => exitSurvey(page, EXIT_CONFIDENCE[arm][seat])),
    );
    log(arm, "group done ✓");
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
  }
}

const conditions = await api("/conditions");
const previousActive = new Map(
  ARMS.map((arm) => [arm, conditions.find((c) => c.id === arm)?.active ?? false]),
);
for (const arm of ARMS) {
  const condition = conditions.find((c) => c.id === arm);
  if (!condition) throw new Error(`condition ${arm} not found`);
  await api(`/conditions/${arm}`, {
    method: "PUT",
    body: JSON.stringify({ condition: { ...condition, active: true } }),
  });
}
log("all", `arms activated: ${ARMS.join(", ")}`);

const browser = await chromium.launch();
try {
  await Promise.all(ARMS.map((arm) => runGroup(browser, arm)));
} finally {
  await browser.close();
  // Restore the recruiting switches the researcher had set.
  const fresh = await api("/conditions");
  for (const arm of ARMS) {
    const condition = fresh.find((c) => c.id === arm);
    await api(`/conditions/${arm}`, {
      method: "PUT",
      body: JSON.stringify({
        condition: { ...condition, active: previousActive.get(arm) },
      }),
    });
  }
  log("all", "recruiting switches restored");
}
log("all", "DEMO RUN COMPLETE");
