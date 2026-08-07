#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const profilesPath = path.resolve(here, "../profiles.json");
const profiles = JSON.parse(await readFile(profilesPath, "utf8"));

const action = process.argv[2];
const conditionId = process.env.LOADTEST_CONDITION_ID;
const baseUrl = trimSlash(process.env.LOADTEST_BASE_URL ?? "http://localhost:3000");
const adminToken = process.env.LOADTEST_ADMIN_TOKEN ?? "";
const profileName = process.env.LOADTEST_PROFILE ?? "smoke";
const groupSize = integerEnv("LOADTEST_GROUP_SIZE", 3);
const durationMinutes = integerEnv("LOADTEST_SESSION_MINUTES", 120);
const resultDir = process.env.LOADTEST_RESULT_DIR;

if (!["create", "deactivate"].includes(action)) {
  fail("Usage: condition.mjs create|deactivate");
}
if (!conditionId?.startsWith("e2e-load-")) {
  fail("LOADTEST_CONDITION_ID must start with e2e-load-");
}
if (!profiles[profileName]) {
  fail(`Unknown profile "${profileName}"`);
}

const headers = {
  "Content-Type": "application/json",
  ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
};

if (action === "create") {
  const maxUsers = Math.max(...profiles[profileName].stages.map((stage) => stage.target));
  if (maxUsers % groupSize !== 0) {
    fail(
      `Profile ${profileName} peaks at ${maxUsers}, which is not divisible by group size ${groupSize}`,
    );
  }

  // Goal counts sessions, not participants. Keep headroom for retries and
  // optional browser canaries without allowing this condition into exports.
  const goal = Math.ceil(maxUsers / groupSize) + 20;
  const condition = {
    id: conditionId,
    name: `Load test ${conditionId.slice("e2e-load-".length)}`,
    active: true,
    goal,
    durationMinutes,
    groupSize,
    config: {
      interventionMode: "baseline",
      llmMode: "off",
      contributionThreshold: 0.4,
      protectedStartMinutes: 3,
      protectedEndMinutes: 2,
      interventionWindowMinutes: 4,
      contributionWindowMinutes: 4,
      scoreWeights: { messages: 1, characters: 0.01 },
      ignoredGraceSeconds: 75,
      ignoredMinSubsequentMessages: 2
    }
  };

  await putCondition(condition);
  const metadata = {
    createdAt: new Date().toISOString(),
    baseUrl,
    profile: profileName,
    maxUsers,
    condition
  };
  if (resultDir) {
    await writeFile(
      path.join(resultDir, "run-metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  }
  process.stdout.write(
    `Created isolated condition ${conditionId} (${maxUsers} users, ${goal} session goal, LLM off)\n`,
  );
} else {
  const response = await fetch(`${baseUrl}/api/conditions`, { headers });
  await requireOk(response, "load condition list");
  const conditions = await response.json();
  const condition = conditions.find((item) => item.id === conditionId);
  if (!condition) {
    process.stdout.write(`Condition ${conditionId} no longer exists\n`);
    process.exit(0);
  }
  await putCondition({ ...condition, active: false });
  process.stdout.write(`Deactivated condition ${conditionId}\n`);
}

async function putCondition(condition) {
  const response = await fetch(
    `${baseUrl}/api/conditions/${encodeURIComponent(condition.id)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ condition }),
    },
  );
  await requireOk(response, `upsert condition ${condition.id}`);
}

async function requireOk(response, label) {
  if (response.ok) return;
  const body = await response.text();
  fail(`${label} failed: HTTP ${response.status} ${body.slice(0, 500)}`);
}

function integerEnv(name, fallback) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${name} must be a positive integer`);
  return parsed;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
