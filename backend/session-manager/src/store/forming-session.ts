import { randomInt, randomUUID } from "node:crypto";
import { MOON_SURVIVAL, MOON_SURVIVAL_BRIEFING } from "@gdm/shared";
import type { Condition, Session } from "@gdm/shared";
import { waitingTimeoutMinutes } from "./waiting-timeout";

const BRIEFING = MOON_SURVIVAL_BRIEFING;
const RANKING_TASK = MOON_SURVIVAL;

/**
 * A fresh waiting lobby for one condition, stamped with the open round and
 * a durable waiting deadline. `now` is the creation time (ISO 8601).
 */
export function newFormingSession(
  condition: Condition,
  roundId: number,
  now: string,
): Session {
  const waitingMinutes = waitingTimeoutMinutes();
  return {
    id: randomUUID(),
    status: "waiting",
    // Stamped once from the open round; the session never changes rounds.
    roundId,
    condition,
    bot: { llmEnabled: condition.config.llmMode === "active", condition },
    participants: [],
    chat: { messages: [] },
    briefing: BRIEFING,
    rankingTask: RANKING_TASK,
    ranking: {
      taskId: RANKING_TASK.id,
      // Shuffle once when the group session is created. The persisted order
      // is then shared with every participant in that session.
      order: condition.config.workspaceMode === "etherpad" ? [] : shuffleRankingOrder(RANKING_TASK.items.map((i) => i.id)),
      updatedAt: now,
      updatedBy: "system",
    },
    interventions: [],
    behavioralEvents: [],
    contributionClassifications: [],
    windowEvaluations: [],
    classificationFailures: [],
    processedEventIds: [],
    redactedReactionEventIds: [],
    reactionEvents: [],
    runtimeState: {},
    polls: [],
    durationMinutes: condition.durationMinutes,
    waitingDeadlineAt: new Date(
      Date.parse(now) + waitingMinutes * 60_000,
    ).toISOString(),
    createdAt: now,
  };
}

/** Unbiased Fisher-Yates shuffle for a new shared-ranking starting order. */
export function shuffleRankingOrder(
  itemIds: string[],
  pickIndex: (maxExclusive: number) => number = randomInt,
): string[] {
  const shuffled = itemIds.slice();
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapWith = pickIndex(index + 1);
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith],
      shuffled[index],
    ];
  }
  return shuffled;
}
