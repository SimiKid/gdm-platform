import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVENTION_CONFIG,
  MOON_SURVIVAL_EXPERT_RANKING,
} from "@gdm/shared";
import type { Condition, Session, Survey } from "@gdm/shared";
import { StoreService } from "../store/store.service";
import { ReportsService } from "./reports.service";
import { pseudonymize } from "./pseudonym";

const EXPERT_ORDER = Object.entries(MOON_SURVIVAL_EXPERT_RANKING)
  .sort(([, a], [, b]) => a - b)
  .map(([id]) => id);

const U1 = "@gdm_u1:localhost";
const U2 = "@gdm_u2:localhost";
const BOT = "@gdm_bot:localhost";

function condition(id: string, overrides: Partial<Condition["config"]> = {}): Condition {
  return {
    id,
    name: `Condition ${id}`,
    active: true,
    goal: 5,
    durationMinutes: 10,
    groupSize: 2,
    config: {
      ...DEFAULT_INTERVENTION_CONFIG,
      interventionMode: "private",
      llmMode: "active",
      ...overrides,
    },
  };
}

function entrySurvey(overrides: Record<string, unknown> = {}): Survey {
  return {
    submittedAt: "2026-07-30T10:00:00.000Z",
    answers: {
      consentAdult: true,
      consentInformed: true,
      consentParticipation: true,
      age: 29,
      gender: "prefer not to say",
      education: "MSc",
      fieldOfStudy: "=cmd()", // hostile on purpose: formula-injection guard
      englishProficiency: 6,
      teamworkFrequency: 5,
      chatComfort: 7,
      topicFamiliarity: 2,
      individualRanking: EXPERT_ORDER,
      rankingCompleted: true,
      rankingSecondsUsed: 240,
      ...overrides,
    } as Survey["answers"],
  };
}

function exitSurvey(overrides: Record<string, unknown> = {}): Survey {
  return {
    submittedAt: "2026-07-30T10:30:00.000Z",
    answers: {
      finalRanking: [...EXPERT_ORDER].reverse(),
      satisfaction: 6,
      fairness: 5,
      feltHeard: 4,
      ...overrides,
    } as Survey["answers"],
  };
}

async function seedSession(
  store: StoreService,
  cond: Condition,
): Promise<Session> {
  const session = await store.createForming(cond);
  session.participants.push(
    {
      id: "p1",
      name: "P One",
      trackingToken: "PROLIFIC-1",
      matrixUserId: U1,
      entrySurvey: entrySurvey(),
      exitSurvey: exitSurvey(),
    },
    {
      id: "p2",
      name: "P Two",
      trackingToken: "PROLIFIC-2",
      matrixUserId: U2,
      entrySurvey: entrySurvey({ rankingCompleted: false }),
      // no exit survey (dropped out before the end)
    },
  );
  session.status = "completed";
  session.startedAt = "2026-07-30T10:05:00.000Z";
  session.completedAt = "2026-07-30T10:35:00.000Z";
  session.roomId = "!room:localhost";
  session.chat.messages = [
    {
      id: "m1",
      timestamp: "2026-07-30T10:10:00.000Z",
      senderId: U1,
      recipientId: null,
      text: "one two three four", // 1 + 4×0.05 = 1.2
      reactions: [],
    },
    {
      id: "m2",
      timestamp: "2026-07-30T10:11:00.000Z",
      senderId: U2,
      recipientId: null,
      text: "five", // 1 + 0.05 = 1.05
      reactions: [],
    },
    {
      id: "m3",
      timestamp: "2026-07-30T10:12:00.000Z",
      senderId: BOT,
      recipientId: U1,
      text: "@Red, a private nudge",
      reactions: [],
    },
  ];
  session.ranking = {
    taskId: "moon-survival",
    order: EXPERT_ORDER,
    updatedAt: "2026-07-30T10:30:00.000Z",
    updatedBy: "p1",
  };
  session.rankingHistory = [session.ranking];
  session.interventions = [
    {
      id: "i1",
      sessionId: session.id,
      roomId: "!room:localhost",
      conditionId: cond.id,
      mode: "private",
      audience: "private",
      timestamp: "2026-07-30T10:12:00.000Z",
      trigger: "contribution-threshold",
      threshold: 0.4,
      llmMode: "active",
      contributionWindowMinutes: 4,
      contributionSplit: [],
      targets: [{ userId: U1, identityName: "Red" }],
      quietMembers: [],
      message: "@Red, a private nudge",
    },
  ];
  session.windowEvaluations = [
    {
      id: "w0",
      sessionId: session.id,
      conditionId: cond.id,
      arm: "primary",
      windowIndex: 0,
      windowStart: "2026-07-30T10:08:00.000Z",
      windowEnd: "2026-07-30T10:12:00.000Z",
      contributionWindowMinutes: 4,
      llmMode: "active",
      threshold: 0.4,
      outcome: "nudged",
      contributionSplit: [
        {
          userId: U1,
          identityName: "Red",
          messageCount: 1,
          wordCount: 4,
          score: 1.2,
          share: 0.53,
          meaningfulnessScore: 0.67,
          dominanceScore: 0.55,
        },
        {
          userId: U2,
          identityName: "Blue",
          messageCount: 1,
          wordCount: 1,
          score: 1.05,
          share: 0.47,
          meaningfulnessScore: 0,
          dominanceScore: 0.42,
        },
      ],
      candidateTargets: [
        { userId: U1, identityName: "Red" },
        { userId: U2, identityName: "Blue" },
      ],
      maxDominanceScore: 0.55,
      interventionId: "i1",
    },
    {
      id: "w1",
      sessionId: session.id,
      conditionId: cond.id,
      arm: "primary",
      windowIndex: 1,
      windowStart: "2026-07-30T10:12:00.000Z",
      windowEnd: "2026-07-30T10:16:00.000Z",
      contributionWindowMinutes: 4,
      llmMode: "active",
      threshold: 0.4,
      outcome: "wrap-up",
      contributionSplit: [],
      candidateTargets: [],
      maxDominanceScore: null,
      interventionId: null,
    },
  ];
  session.contributionClassifications = [
    {
      messageId: "m1",
      senderId: U1,
      classifiedAt: "2026-07-30T10:10:01.000Z",
      respondsToPrior: { value: true, reason: "r" },
      referencesTaskItem: { value: true, reason: "r" },
      hasDiscussionStructure: { value: false, reason: "r" },
      invitesParticipation: { value: false, reason: "r" },
      meaningfulnessScore: 2 / 3,
      model: "test",
      promptVersion: "v1",
      prompt: "p",
      rawOutput: "{}",
    },
  ];
  session.classificationFailures = [
    {
      messageId: "m2",
      senderId: U2,
      failedAt: "2026-07-30T10:11:01.000Z",
      model: "test",
      promptVersion: "v1",
      error: "boom",
    },
  ];
  session.behavioralEvents = [
    {
      id: "b1",
      type: "typing-stop",
      participantId: U1,
      timestamp: "2026-07-30T10:09:00.000Z",
      durationMs: 800,
    },
    {
      id: "b2",
      type: "tab-hidden",
      participantId: U2,
      timestamp: "2026-07-30T10:09:30.000Z",
    },
  ];
  await store.saveSession(session);
  return session;
}

describe("ReportsService (in-memory store)", () => {
  let store: StoreService;
  let reports: ReportsService;
  let session: Session;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    store = new StoreService();
    reports = new ReportsService(store);
    session = await seedSession(store, condition("private-llm-test"));
  });

  it("builds one participant row per participant with scores and nudges", async () => {
    const { participants } = await reports.exportParticipants();
    expect(participants).toHaveLength(2);
    const [p1, p2] = participants;

    expect(p1).toMatchObject({
      participantPseudonym: pseudonymize("P", "p1"),
      sessionPseudonym: pseudonymize("S", session.id),
      interventionMode: "private",
      llmMode: "active",
      individualRankingError: 0,
      exitRankingError: 112,
      satisfaction: 6,
      messageCount: 1,
      wordCount: 4,
      nudgesReceivedTotal: 1,
      nudgesReceivedPrivate: 1,
      nudgesReceivedPublic: 0,
      typingDurationMs: 800,
      classifiedMessageCount: 1,
    });
    expect(p1.contributionShare).toBeCloseTo(1.2 / 2.25, 3);

    // Timed-out entry ranking is not scored; missing exit survey stays empty.
    expect(p2).toMatchObject({
      individualRankingCompleted: false,
      individualRankingError: null,
      exitSubmitted: null,
      satisfaction: null,
      nudgesReceivedTotal: 0,
      tabHiddenCount: 1,
    });
  });

  it("emits no raw identifiers in the participants CSV and guards formulas", async () => {
    const csv = await reports.exportParticipantsCsv();
    expect(csv).not.toContain("PROLIFIC-1");
    expect(csv).not.toContain(U1);
    expect(csv).not.toContain(session.id);
    expect(csv).not.toContain("p1,"); // raw internal id never a cell
    expect(csv).toContain(pseudonymize("P", "p1"));
    expect(csv).toContain("'=cmd()"); // formula-injection guard
  });

  it("derives session-level analysis measures", async () => {
    const { sessions } = await reports.exportSessionsAnalysis();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionPseudonym: pseudonymize("S", session.id),
      status: "completed",
      nParticipants: 2,
      groupRankingError: 0,
      participantMessageCount: 2,
      botMessageCount: 1,
      wordCountTotal: 5,
      interventionCount: 1,
      interventionsPrivate: 1,
      windowsEvaluated: 2,
      windowsNudged: 1,
      classificationCount: 1,
      classificationFailureCount: 1,
      entrySurveys: 2,
      exitSurveys: 1,
      meanSatisfaction: 6,
    });
    expect(sessions[0].shareStdDev).toBeCloseTo(
      Math.abs(1.2 / 2.25 - 0.5),
      3,
    );
    expect(sessions[0].shareGini).not.toBeNull();
  });

  it("exports windows in long format with one row per participant and empty rows for unevaluated windows", async () => {
    const csv = await reports.exportWindowsCsv();
    const lines = csv.split("\n");
    // Header + 2 split rows (window 0) + 1 empty row (wrap-up window).
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("was_nudged");
    expect(lines[1]).toContain("nudged");
    expect(lines[1]).toContain(pseudonymize("P", "p1"));
    expect(lines[1].endsWith("true,true")).toBe(true); // candidate + nudged
    expect(lines[2].endsWith("true,false")).toBe(true); // candidate, not nudged
    expect(lines[3]).toContain("wrap-up");
    expect(csv).not.toContain(U1);
  });

  it("links pseudonyms back to identifying data only in linkage.csv", async () => {
    const csv = await reports.exportLinkageCsv();
    expect(csv).toContain("PROLIFIC-1");
    expect(csv).toContain(U1);
    expect(csv).toContain(pseudonymize("P", "p1"));
    expect(csv).toContain(session.id);
  });

  it("summarizes per condition over completed sessions", async () => {
    const summary = await reports.summary();
    const row = summary.conditions.find(
      (item) => item.conditionId === "private-llm-test",
    );
    expect(row).toMatchObject({
      interventionMode: "private",
      llmMode: "active",
      sessionsCompleted: 1,
      participants: 2,
      entrySurveys: 2,
      exitSurveys: 1,
      meanGroupRankingError: 0,
      meanIndividualRankingError: 0,
      meanExitRankingError: 112,
      meanSatisfaction: 6,
      nudgesTotal: 1,
      nudgesPerSessionMean: 1,
      windowsEvaluated: 2,
      windowsNudged: 1,
    });
    // Seeded default conditions appear with zero data rather than vanishing.
    expect(
      summary.conditions.some((item) => item.conditionId === "baseline"),
    ).toBe(true);
  });

  it("excludes aborted sessions from summary means but keeps them in exports", async () => {
    const aborted = await seedSession(store, condition("private-llm-test"));
    aborted.status = "aborted";
    await store.saveSession(aborted);

    const summary = await reports.summary();
    const row = summary.conditions.find(
      (item) => item.conditionId === "private-llm-test",
    )!;
    expect(row.sessionsCompleted).toBe(1);
    expect(row.sessionsAborted).toBe(1);

    const { sessions } = await reports.exportSessionsAnalysis();
    expect(sessions.map((item) => item.status).sort()).toEqual([
      "aborted",
      "completed",
    ]);
  });

  it("always filters e2e- conditions and honors conditionIds", async () => {
    await seedSession(store, condition("e2e-run-1"));
    const all = await reports.exportSessionsAnalysis();
    expect(all.sessions).toHaveLength(1);

    const filtered = await reports.exportSessionsAnalysis({ conditionIds: ["other-condition"] });
    expect(filtered.sessions).toHaveLength(0);
  });

  it("filters by roundIds and stamps the round column everywhere", async () => {
    await store.startNewRound("second wave");
    const second = await seedSession(store, condition("private-llm-test"));
    expect(second.roundId).toBe(2);

    const all = await reports.exportSessionsAnalysis();
    expect(all.sessions.map((row) => row.round).sort()).toEqual([1, 2]);

    const onlyTwo = await reports.exportSessionsAnalysis({ roundIds: [2] });
    expect(onlyTwo.sessions).toHaveLength(1);
    expect(onlyTwo.sessions[0].round).toBe(2);
    expect(onlyTwo.sessions[0].sessionPseudonym).toBe(
      pseudonymize("S", second.id),
    );

    const participantsCsv = await reports.exportParticipantsCsv({
      roundIds: [1],
    });
    expect(participantsCsv.split("\n")[0]).toContain(",round,");
    expect(participantsCsv).toContain(pseudonymize("S", session.id));
    expect(participantsCsv).not.toContain(pseudonymize("S", second.id));

    const windowsCsv = await reports.exportWindowsCsv({ roundIds: [2] });
    expect(windowsCsv.split("\n")[0]).toContain(",round,");
    expect(windowsCsv).not.toContain(pseudonymize("S", session.id));

    // A rounds-only filter still lists every condition in the summary.
    const summary = await reports.summary({ roundIds: [2] });
    const row = summary.conditions.find(
      (item) => item.conditionId === "private-llm-test",
    );
    expect(row?.sessionsCompleted).toBe(1);
    expect(
      summary.conditions.some((item) => item.conditionId === "baseline"),
    ).toBe(true);
  });

  it("exports raw ranking orders with editors, edit history, and item ranks", async () => {
    const { rankings } = await reports.exportRankings();
    expect(rankings.map((row) => row.type)).toEqual([
      "entry", // p1
      "exit", // p1
      "entry", // p2 (no exit survey)
      "group-edit",
      "group-final",
    ]);

    const [entry1, exit1, entry2, edit, final] = rankings;
    // p1 submitted the expert order: error 0, oxygen ranked 1, matches 15.
    expect(entry1).toMatchObject({
      participantPseudonym: pseudonymize("P", "p1"),
      rankingCompleted: true,
      error: 0,
    });
    expect(entry1.ranks.oxygen).toBe(1);
    expect(entry1.ranks.matches).toBe(15);
    // p1's exit ranking is fully reversed.
    expect(exit1).toMatchObject({ error: 112 });
    expect(exit1.ranks.oxygen).toBe(15);
    // p2 timed out: raw order present, but not scored.
    expect(entry2).toMatchObject({ rankingCompleted: false, error: null });
    expect(entry2.order).toHaveLength(15);
    // Group history: edited by p1 (resolved to their pseudonym), expert order.
    expect(edit).toMatchObject({
      editIndex: 0,
      participantPseudonym: pseudonymize("P", "p1"),
      error: 0,
    });
    expect(final).toMatchObject({ type: "group-final", error: 0 });

    const csv = await reports.exportRankingsCsv();
    expect(csv.split("\n")[0]).toContain(",oxygen,");
    expect(csv).not.toContain("PROLIFIC-1");
    expect(csv).not.toContain(U1);
    expect(csv).not.toContain(session.id);
  });

  it("bundles all research CSVs plus the codebook, without linkage", async () => {
    const zip = await reports.bundleZip();
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
