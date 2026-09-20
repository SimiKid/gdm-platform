import { vi } from "vitest";
import type { Condition, ConditionProgress, SessionSummary } from "@gdm/shared";

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
    if (value && typeof value === "object" && "status" in (value as object)) {
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
