import type { Session } from "@gdm/shared";

/** Axes every export/report endpoint can be restricted by. */
export interface ResearchFilter {
  /** Condition ids; empty/absent = all study arms. */
  conditionIds?: string[];
  /** Study round numbers; empty/absent = all rounds. */
  roundIds?: number[];
}

/** `?conditionIds=a,b,c` query string -> id list (empty = everything). */
export function parseConditionIds(conditionIds?: string): string[] {
  return conditionIds
    ? conditionIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/** `?roundIds=1,2` query string -> round numbers (empty = everything). */
export function parseRoundIds(roundIds?: string): number[] {
  return roundIds
    ? roundIds
        .split(",")
        .map((id) => Number(id.trim()))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];
}

/**
 * Sessions that belong in the research record: E2E residue (`e2e-…`
 * conditions) is always excluded; non-empty condition/round lists restrict
 * further. Every export and report endpoint must go through this filter.
 */
export function filterResearchSessions(
  sessions: Session[],
  filter: ResearchFilter = {},
): Session[] {
  const conditions = new Set(filter.conditionIds ?? []);
  const rounds = new Set(filter.roundIds ?? []);
  return sessions.filter(
    (session) =>
      !session.condition.id.startsWith("e2e-") &&
      (conditions.size === 0 || conditions.has(session.condition.id)) &&
      (rounds.size === 0 || rounds.has(session.roundId)),
  );
}
