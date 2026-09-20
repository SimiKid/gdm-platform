import { vi } from "vitest";
import type {
  Condition,
  ConditionProgress,
  ContributionShare,
  Session,
  SessionSummary,
  WindowEvaluation,
} from "@gdm/shared";

type Handler = (init: RequestInit | undefined, url: string) => unknown;
type RouteValue = unknown | Handler;

/**
 * Stub `fetch` with a path → response table. Values are JSON bodies (or a
 * function producing one); `{ status }` objects produce non-ok responses.
 * Returns the stub so tests can assert on the calls that were made.
 */
export function mockApi(routes: Record<string, RouteValue>) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = Object.keys(routes).find(
      (route) => path === route || path.startsWith(`${route}?`),
    );
    if (key === undefined) {
      return response({ status: 404, body: { error: `no route for ${path}` } });
    }
    const raw = routes[key];
    const value = typeof raw === "function" ? (raw as Handler)(init, url) : raw;
    // `{ status: 404 }` shapes a failed response; a session's own string
    // `status` ("completed") is just body data.
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { status?: unknown }).status === "number"
    ) {
      const { status, body } = value as { status: number; body?: unknown };
      return response({ status, body: body ?? null });
    }
    return response({ status: 200, body: value });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function response({ status, body }: { status: number; body: unknown }) {
  const text = body === null || body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
    blob: async () => new Blob([text], { type: "application/json" }),
  };
}

/** The request paths `fetch` was called with, in order (query included). */
export function calledPaths(fetchMock: ReturnType<typeof mockApi>): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    String(input).replace(/^https?:\/\/[^/]+\/api/, ""),
  );
}

export function condition(overrides: Partial<Condition> = {}): Condition {
  return {
    id: "baseline",
    name: "Baseline",
    active: true,
    goal: 5,
    durationMinutes: 10,
    groupSize: 3,
    // Only the knobs the dashboard reads; the bot-side weights are irrelevant here.
    config: {
      interventionMode: "baseline",
      contributionThreshold: 0.4,
      protectedStartMinutes: 1,
      protectedEndMinutes: 0.5,
      contributionWindowMinutes: 1,
    } as unknown as Condition["config"],
    ...overrides,
  };
}

export function progress(
  overrides: Partial<Condition> = {},
  completed = 0,
): ConditionProgress {
  const c = condition(overrides);
  return { condition: c, completed, goal: c.goal };
}

export function sessionSummary(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "11112222-3333-4444-5555-666677778888",
    status: "completed",
    roundId: 1,
    conditionId: "baseline",
    conditionName: "Baseline",
    participantCount: 3,
    groupSize: 3,
    messageCount: 12,
    interventionCount: 0,
    rankingEditCount: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    startedAt: "2026-09-01T10:05:00.000Z",
    completedAt: "2026-09-01T10:20:00.000Z",
    ...overrides,
  };
}

const A = "@a:localhost";
const B = "@b:localhost";
const C = "@c:localhost";
const BOT = "@gdm_bot:localhost";
const SESSION_ID = "11112222-3333-4444-5555-666677778888";

function share(
  userId: string,
  identityName: string,
  messageCount: number,
  wordCount: number,
  value: number,
): ContributionShare {
  return {
    userId,
    identityName,
    messageCount,
    wordCount,
    score: messageCount + wordCount * 0.05,
    share: value,
    meaningfulnessScore: 0,
    dominanceScore: value,
  };
}

function windowEval(
  windowIndex: number,
  start: string,
  end: string,
  outcome: WindowEvaluation["outcome"],
  contributionSplit: ContributionShare[],
  extra: Partial<WindowEvaluation> = {},
): WindowEvaluation {
  return {
    id: `w${windowIndex}`,
    sessionId: SESSION_ID,
    conditionId: "public-llm",
    windowIndex,
    windowStart: `2026-09-01T${start}.000Z`,
    windowEnd: `2026-09-01T${end}.000Z`,
    contributionWindowMinutes: 2,
    llmMode: "active",
    threshold: 0.4,
    outcome,
    contributionSplit,
    candidateTargets: [],
    maxDominanceScore: contributionSplit.length
      ? Math.max(...contributionSplit.map((s) => s.dominanceScore))
      : null,
    interventionId: null,
    ...extra,
  };
}

function message(id: string, senderId: string, at: string, text: string, recipientId?: string) {
  return {
    id,
    senderId,
    timestamp: `2026-09-01T${at}.000Z`,
    text,
    reactions: [],
    ...(recipientId ? { recipientId } : {}),
  };
}

/**
 * A complete, realistic nudging-arm session: three participants (Red, Blue,
 * Green by sorted Matrix id), a 10-minute chat started at 10:00Z, one public
 * nudge at 10:03 targeting Red, and window evaluations before and after it.
 */
export function session(overrides: Partial<Session> = {}): Session {
  const split0 = [share(A, "Red", 2, 20, 0.67), share(B, "Blue", 1, 8, 0.33), share(C, "Green", 0, 0, 0)];
  const split1 = [share(A, "Red", 1, 6, 0.34), share(B, "Blue", 1, 5, 0.33), share(C, "Green", 1, 5, 0.33)];
  const split2 = [share(A, "Red", 0, 0, 0), share(B, "Blue", 1, 4, 0.5), share(C, "Green", 1, 4, 0.5)];
  const cond = condition({
    id: "public-llm",
    name: "Public × Rule+LLM",
    durationMinutes: 10,
    config: {
      interventionMode: "public",
      contributionThreshold: 0.4,
      protectedStartMinutes: 1,
      protectedEndMinutes: 1,
      inviteGraceSeconds: 60,
      contributionWindowMinutes: 2,
      scoreWeights: { messages: 1, words: 0.05 },
      dominanceWeights: { share: 0.9, meaningfulness: 0.1 },
      llmMode: "active",
    } as unknown as Condition["config"],
  });
  const participant = (id: string, token: string, matrixUserId: string) => ({
    id,
    name: "",
    trackingToken: token,
    recruitmentSource: "direct" as const,
    matrixUserId,
  });
  return {
    id: SESSION_ID,
    status: "completed",
    roundId: 1,
    condition: cond,
    bot: {} as Session["bot"],
    participants: [
      participant("p1", "tok-aaaaaaaa-rest", A),
      participant("p2", "tok-bbbbbbbb-rest", B),
      participant("p3", "tok-cccccccc-rest", C),
    ],
    chat: {
      messages: [
        message("m1", A, "10:01:30", "Oxygen first, obviously."),
        message("m2", A, "10:02:00", "Then water."),
        message("m3", B, "10:02:30", "Agreed on oxygen."),
        message("bot1", BOT, "10:03:00", "Red, you have written 67% of the messages so far."),
        message("m4", A, "10:04:10", "What do you two think?"),
        message("m5", C, "10:05:00", "I'd put the map higher."),
        message("m6", B, "10:05:30", "Map third works for me."),
      ],
    },
    briefing: {} as Session["briefing"],
    rankingTask: {} as Session["rankingTask"],
    ranking: {} as Session["ranking"],
    rankingHistory: [{} as Session["ranking"], {} as Session["ranking"]],
    interventions: [
      {
        id: "n1",
        sessionId: SESSION_ID,
        roomId: "!room:localhost",
        conditionId: "public-llm",
        mode: "public",
        audience: "public",
        timestamp: "2026-09-01T10:03:00.000Z",
        trigger: "contribution-threshold",
        threshold: 0.4,
        llmMode: "active",
        contributionWindowMinutes: 2,
        contributionSplit: split0,
        targets: [{ userId: A, identityName: "Red" }],
        quietMembers: [{ userId: C, identityName: "Green" }],
        message: "Red, you have written 67% of the messages so far. Green, what do you think?",
      },
    ],
    behavioralEvents: [
      { id: "e1", type: "typing-stop", participantId: A, timestamp: "2026-09-01T10:01:29.000Z", durationMs: 5000 },
      { id: "e2", type: "typing-stop", participantId: B, timestamp: "2026-09-01T10:02:29.000Z", durationMs: 3000 },
      { id: "e3", type: "tab-hidden", participantId: C, timestamp: "2026-09-01T10:03:30.000Z" },
      { id: "e4", type: "ranking-move", participantId: A, timestamp: "2026-09-01T10:04:00.000Z" },
      { id: "e5", type: "ranking-move", participantId: A, timestamp: "2026-09-01T10:06:00.000Z" },
      { id: "e6", type: "cursor-activity", participantId: A, timestamp: "2026-09-01T10:06:10.000Z" },
    ],
    contributionClassifications: [
      {
        messageId: "m1",
        senderId: A,
        classifiedAt: "2026-09-01T10:01:31.000Z",
        relevance: { rating: 5, reason: "names oxygen" },
        coherence: { rating: 2, reason: "opens the discussion" },
        invitesParticipation: { value: false, reason: "" },
        meaningfulnessScore: 0.75,
        model: "test",
        promptVersion: "meaningfulness-v2",
        prompt: "p",
        rawOutput: "{}",
      },
      {
        messageId: "m4",
        senderId: A,
        classifiedAt: "2026-09-01T10:04:11.000Z",
        relevance: { rating: 1, reason: "no task content" },
        coherence: { rating: 3, reason: "addresses the others" },
        invitesParticipation: { value: true, reason: "asks the group" },
        meaningfulnessScore: 0.25,
        model: "test",
        promptVersion: "meaningfulness-v2",
        prompt: "p",
        rawOutput: "{}",
      },
    ],
    classificationFailures: [
      { messageId: "m2", senderId: A, failedAt: "2026-09-01T10:02:01.000Z", model: "test", promptVersion: "meaningfulness-v2", error: "boom" },
    ],
    windowEvaluations: [
      windowEval(0, "10:01:00", "10:03:00", "nudged", split0, {
        candidateTargets: [{ userId: A, identityName: "Red" }],
        interventionId: "n1",
      }),
      windowEval(1, "10:03:00", "10:05:00", "no-target", split1),
      windowEval(2, "10:05:00", "10:07:00", "no-target", split2),
      windowEval(3, "10:07:00", "10:09:00", "wrap-up", []),
    ],
    polls: [],
    durationMinutes: 10,
    roomId: "!room:localhost",
    createdAt: "2026-09-01T09:55:00.000Z",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T10:10:00.000Z",
    ...overrides,
  };
}
