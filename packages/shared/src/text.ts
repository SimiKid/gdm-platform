/**
 * Small formatting and counting helpers shared by the services and frontends.
 * The Chat Service's live contribution split and the Session Manager's research
 * exports must count words identically, so both use {@link countWords}.
 */

/** Whitespace-separated word count of a chat message. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Whole seconds → `m:ss` (negative input clamps to `0:00`). */
export function formatMmSs(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Condition ids of automated E2E runs start with this prefix. */
export const TEST_CONDITION_PREFIX = "e2e-";

/** True for conditions created by automated E2E runs (excluded from research data). */
export function isTestCondition(conditionId: string): boolean {
  return conditionId.startsWith(TEST_CONDITION_PREFIX);
}
