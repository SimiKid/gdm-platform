import type { Session } from "@gdm/shared";

/** `?conditionIds=a,b,c` query string -> id list (empty = everything). */
export function parseConditionIds(conditionIds?: string): string[] {
  return conditionIds
    ? conditionIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}

/**
 * Sessions that belong in the research record: E2E residue (`e2e-…`
 * conditions) is always excluded, and a non-empty id list restricts to those
 * conditions. Every export and report endpoint must go through this filter.
 */
export function filterResearchSessions(
  sessions: Session[],
  conditionIds: string[] = [],
): Session[] {
  const allowed = new Set(conditionIds);
  return sessions.filter(
    (session) =>
      !session.condition.id.startsWith("e2e-") &&
      (allowed.size === 0 || allowed.has(session.condition.id)),
  );
}
