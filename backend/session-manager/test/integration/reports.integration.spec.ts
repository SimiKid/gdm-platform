import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { MOON_SURVIVAL_EXPERT_RANKING } from "@gdm/shared";
import type {
  ClassificationFailure,
  RuntimeCheckpoint,
  WindowEvaluation,
} from "@gdm/shared";
import { pseudonymize } from "../../src/reports/pseudonym";
import {
  closeHarness,
  createTestApp,
  fillSession,
  resetDatabase,
  type TestApp,
} from "./harness";

const EXPERT_ORDER = Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
  .sort(([, a], [, b]) => a - b)
  .map(([id]) => id);

function emptyCheckpoint(): RuntimeCheckpoint {
  return {
    messages: [],
    rankingHistory: [],
    interventions: [],
    behavioralEvents: [],
    contributionClassifications: [],
    windowEvaluations: [],
    classificationFailures: [],
    processedEventIds: [],
    ruleState: {},
  };
}

function windowEvaluation(
  sessionId: string,
  userIds: string[],
  overrides: Partial<WindowEvaluation> = {},
): WindowEvaluation {
  return {
    id: `w-${overrides.windowIndex ?? 0}`,
    sessionId,
    conditionId: "public-llm",
    arm: "primary",
    windowIndex: 0,
    windowStart: "2026-07-30T10:08:00.000Z",
    windowEnd: "2026-07-30T10:12:00.000Z",
    contributionWindowMinutes: 4,
    llmMode: "active",
    threshold: 0.4,
    outcome: "no-target",
    contributionSplit: userIds.map((userId, index) => ({
      userId,
      identityName: `Member${index}`,
      messageCount: 1,
      wordCount: 5,
      score: 1.25,
      share: 1 / userIds.length,
      meaningfulnessScore: 0,
      dominanceScore: 1 / userIds.length,
    })),
    candidateTargets: [],
    maxDominanceScore: 1 / userIds.length,
    interventionId: null,
    ...overrides,
  };
}

/**
 * The research-report path: checkpointed window evaluations and
 * classification failures must survive Postgres round-trips and come back
 * out of the pseudonymized research exports without identifying data.
 */
describe("research reports (integration)", () => {
  let t: TestApp;

  beforeEach(async () => {
    await resetDatabase();
    t = await createTestApp();
  });

  afterEach(() => t.close());
  afterAll(closeHarness);

  it("round-trips window evaluations and classification failures across a restart", async () => {
    const responses = await fillSession(t, "public-llm");
    const sessionId = responses[0].session.id;
    const userIds = responses.map((r) => r.matrix.userId);

    const failures: ClassificationFailure[] = [
      {
        messageId: "$m1:test",
        senderId: userIds[0],
        failedAt: "2026-07-30T10:10:00.000Z",
        model: "test-model",
        promptVersion: "meaningfulness-v1",
        error: "boom",
      },
    ];
    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send({
        ...emptyCheckpoint(),
        windowEvaluations: [
          windowEvaluation(sessionId, userIds),
          windowEvaluation(sessionId, [], {
            windowIndex: 1,
            outcome: "warm-up",
            maxDominanceScore: null,
          }),
        ],
        classificationFailures: failures,
      })
      .expect(200);

    // Restart: a fresh app can only answer from Postgres.
    await t.close();
    t = await createTestApp();

    const windows = (
      await request(t.http).get("/api/export/windows").expect(200)
    ).body;
    expect(windows.windows).toHaveLength(2);
    expect(windows.windows[0]).toMatchObject({
      outcome: "no-target",
      windowIndex: 0,
      llmMode: "active",
    });
    expect(windows.windows[0].contributionSplit).toHaveLength(3);
    // Pseudonymized: raw Matrix ids never appear in the research export.
    expect(JSON.stringify(windows)).not.toContain(userIds[0]);
    expect(JSON.stringify(windows)).not.toContain(sessionId);

    const windowsCsv = await request(t.http)
      .get("/api/export/windows.csv")
      .expect(200)
      .expect("Content-Type", /text\/csv/);
    // 3 split rows + 1 empty warm-up row + header.
    expect(windowsCsv.text.split("\n")).toHaveLength(5);

    const analysis = (
      await request(t.http).get("/api/export/sessions-analysis").expect(200)
    ).body;
    expect(analysis.sessions[0]).toMatchObject({
      windowsEvaluated: 2,
      classificationFailureCount: 1,
    });
  });

  it("accepts old-shape checkpoints without the new fields", async () => {
    const responses = await fillSession(t, "baseline");
    const sessionId = responses[0].session.id;
    const { windowEvaluations, classificationFailures, ...oldShape } =
      emptyCheckpoint();
    void windowEvaluations;
    void classificationFailures;

    await request(t.http)
      .put(`/api/sessions/${sessionId}/checkpoint`)
      .send(oldShape)
      .expect(200);

    const windows = (
      await request(t.http).get("/api/export/windows").expect(200)
    ).body;
    expect(windows.windows).toEqual([]);
  });

  it("joins surveys into participants.csv with pseudonyms only; linkage.csv maps back", async () => {
    const responses = await fillSession(t, "private-llm");
    const sessionId = responses[0].session.id;
    const first = responses[0];

    await request(t.http)
      .post("/api/surveys")
      .set("Authorization", "Bearer tt-P1-private-llm")
      .send({
        sessionId,
        participantId: first.participantId,
        kind: "entry",
        survey: {
          submittedAt: "2026-07-30T10:00:00.000Z",
          answers: {
            age: 30,
            gender: "=cmd()",
            individualRanking: EXPERT_ORDER,
            rankingCompleted: true,
            rankingSecondsUsed: 100,
          },
        },
      })
      .expect(201);
    await request(t.http)
      .post("/api/surveys")
      .set("Authorization", "Bearer tt-P1-private-llm")
      .send({
        sessionId,
        participantId: first.participantId,
        kind: "exit",
        survey: {
          submittedAt: "2026-07-30T10:30:00.000Z",
          answers: {
            finalRanking: EXPERT_ORDER,
            satisfaction: 7,
            fairness: 6,
            feltHeard: 5,
          },
        },
      })
      .expect(201);
    await request(t.http)
      .post(`/api/sessions/${sessionId}/finalize`)
      .send({ messages: [], rankingHistory: [] })
      .expect(201);

    const csv = (
      await request(t.http)
        .get("/api/export/participants.csv")
        .expect(200)
        .expect("Content-Type", /text\/csv/)
    ).text;
    const pseudonym = pseudonymize("P", first.participantId);
    expect(csv).toContain(pseudonym);
    expect(csv).toContain("'=cmd()"); // formula-injection guard
    expect(csv).not.toContain(first.participantId);
    expect(csv).not.toContain(sessionId);
    expect(csv).not.toContain(first.matrix.userId);
    expect(csv).not.toContain("tt-"); // tracking tokens
    // Entry/exit scores: perfect expert order → 0 error, satisfaction 7.
    const row = csv
      .split("\n")
      .find((line) => line.startsWith(pseudonym))!;
    expect(row).toContain(",0,"); // ranking error 0 present
    expect(row).toContain("7");

    const rankingsCsv = (
      await request(t.http)
        .get("/api/export/rankings.csv")
        .expect(200)
        .expect("Content-Type", /text\/csv/)
    ).text;
    expect(rankingsCsv.split("\n")[0]).toContain(",oxygen,");
    const entryRow = rankingsCsv
      .split("\n")
      .find((line) => line.includes(",entry,"));
    expect(entryRow).toContain(pseudonym);
    expect(entryRow).toContain(",0,"); // expert order → error 0
    expect(rankingsCsv).not.toContain(first.participantId);
    expect(rankingsCsv).not.toContain("tt-");

    const linkage = (
      await request(t.http).get("/api/export/linkage.csv").expect(200)
    ).text;
    expect(linkage).toContain(pseudonym);
    expect(linkage).toContain(first.participantId);
    expect(linkage).toContain(first.matrix.userId);

    const summary = (
      await request(t.http).get("/api/reports/summary").expect(200)
    ).body;
    const conditionRow = summary.conditions.find(
      (item: { conditionId: string }) => item.conditionId === "private-llm",
    );
    expect(conditionRow).toMatchObject({
      sessionsCompleted: 1,
      participants: 3,
      entrySurveys: 1,
      exitSurveys: 1,
      meanSatisfaction: 7,
      meanIndividualRankingError: 0,
    });
  });

  it("filters research exports by roundIds and stamps the round column", async () => {
    const first = await fillSession(t, "baseline");
    await request(t.http)
      .post(`/api/sessions/${first[0].session.id}/finalize`)
      .send({ messages: [], rankingHistory: [] })
      .expect(201);

    await request(t.http).post("/api/rounds").send({}).expect(201);
    const second = await fillSession(t, "public-llm");
    await request(t.http)
      .post(`/api/sessions/${second[0].session.id}/finalize`)
      .send({ messages: [], rankingHistory: [] })
      .expect(201);

    const all = (
      await request(t.http).get("/api/export/sessions-analysis").expect(200)
    ).body as { sessions: Array<{ round: number }> };
    expect(all.sessions.map((row) => row.round).sort()).toEqual([1, 2]);

    const roundTwo = (
      await request(t.http)
        .get("/api/export/sessions-analysis?roundIds=2")
        .expect(200)
    ).body as { sessions: Array<{ round: number; conditionId: string }> };
    expect(roundTwo.sessions).toHaveLength(1);
    expect(roundTwo.sessions[0]).toMatchObject({
      round: 2,
      conditionId: "public-llm",
    });

    const overview = (
      await request(t.http)
        .get("/api/export/sessions.csv?roundIds=1")
        .expect(200)
    ).text;
    expect(overview.split("\n")[0]).toContain(",round,");
    expect(overview).toContain(first[0].session.id);
    expect(overview).not.toContain(second[0].session.id);
  });

  it("filters research exports by conditionIds", async () => {
    const baseline = await fillSession(t, "baseline");
    await fillSession(t, "public-llm");
    await request(t.http)
      .post(`/api/sessions/${baseline[0].session.id}/finalize`)
      .send({ messages: [], rankingHistory: [] })
      .expect(201);

    const all = (
      await request(t.http).get("/api/export/sessions-analysis").expect(200)
    ).body;
    expect(all.sessions).toHaveLength(2);

    const filtered = (
      await request(t.http)
        .get("/api/export/sessions-analysis?conditionIds=baseline")
        .expect(200)
    ).body;
    expect(filtered.sessions).toHaveLength(1);
    expect(filtered.sessions[0].conditionId).toBe("baseline");
  });

  it("serves the research bundle as a zip with the codebook and no linkage file", async () => {
    await fillSession(t, "baseline");

    const res = await request(t.http)
      .get("/api/export/research.zip")
      .expect(200)
      .expect("Content-Type", /application\/zip/)
      .expect(
        "Content-Disposition",
        'attachment; filename="research_bundle.zip"',
      )
      .responseType("blob");

    const zip = res.body as Buffer;
    expect(zip.subarray(0, 2).toString()).toBe("PK");
    const listing = zip.toString("latin1");
    for (const name of [
      "participants.csv",
      "sessions_analysis.csv",
      "windows.csv",
      "rankings.csv",
      "messages.csv",
      "codebook.md",
    ]) {
      expect(listing).toContain(name);
    }
    expect(listing).not.toContain("linkage");
  });
});
