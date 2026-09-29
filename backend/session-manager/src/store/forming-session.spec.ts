import { afterEach, describe, expect, it, vi } from "vitest";
import { seedConditions } from "./conditions";
import { newFormingSession, shuffleRankingOrder } from "./forming-session";

describe("forming session", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shuffles a ranking without mutating the task item order", () => {
    const itemIds = ["a", "b", "c", "d"];
    const shuffled = shuffleRankingOrder(itemIds, () => 0);

    expect(shuffled).toEqual(["b", "c", "d", "a"]);
    expect(itemIds).toEqual(["a", "b", "c", "d"]);
  });

  it("stamps the round, creation time and waiting deadline", () => {
    vi.stubEnv("WAITING_TIMEOUT_MINUTES", "7");
    const [condition] = seedConditions();
    const now = "2026-09-29T10:00:00.000Z";

    const session = newFormingSession(condition, 4, now);

    expect(session).toMatchObject({
      status: "waiting",
      roundId: 4,
      createdAt: now,
      durationMinutes: condition.durationMinutes,
      waitingDeadlineAt: "2026-09-29T10:07:00.000Z",
      ranking: { updatedAt: now, updatedBy: "system" },
    });
    expect(session.bot.llmEnabled).toBe(false);
  });

  it("gives an Etherpad session no ranking order", () => {
    const [, condition] = seedConditions();
    const session = newFormingSession(
      { ...condition, config: { ...condition.config, workspaceMode: "etherpad" } },
      1,
      "2026-09-29T10:00:00.000Z",
    );

    expect(session.ranking.order).toEqual([]);
    expect(session.bot.llmEnabled).toBe(true);
  });
});
