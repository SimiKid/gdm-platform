import {
  DEFAULT_INTERVENTION_CONFIG,
  normalizeInterventionMode,
} from "@gdm/shared";
import type { Session, Survey } from "@gdm/shared";

/**
 * Small value helpers shared by the research-export row builders: session
 * classification, survey answer access and cell formatting.
 */

// ── session context ────────────────────────────────────────────────

/** Canonical arm label: retired tone suffixes fold onto baseline/public/private. */
export function interventionModeOf(session: Session): string {
  return normalizeInterventionMode(
    session.condition.config.interventionMode ??
      DEFAULT_INTERVENTION_CONFIG.interventionMode,
  );
}

export function llmModeOf(session: Session): string {
  return session.condition.config.llmMode ?? "off";
}

export function isEtherpad(session: Session): boolean {
  return session.condition.config.workspaceMode === "etherpad";
}

// ── survey answers ─────────────────────────────────────────────────

function answer(
  survey: Survey | undefined,
  key: string,
): string | number | boolean | string[] | null {
  const value = survey?.answers[key];
  return value === undefined ? null : value;
}

export function scalarAnswer(
  survey: Survey | undefined,
  key: string,
): string | number | boolean | null {
  const value = answer(survey, key);
  return Array.isArray(value) ? null : value;
}

export function rankingAnswer(
  survey: Survey | undefined,
  key: string,
): string[] | undefined {
  const value = answer(survey, key);
  return Array.isArray(value) ? value : undefined;
}

// ── exit-survey item groups (participants.csv column order) ─────────

export const GROUP_DYNAMICS_KEYS = [
  "groupConsidered", "groupBalanced", "attentionCheck1",
  "groupDominated", "feltTeam", "comfortableAgain",
] as const;

export const PSYCH_SAFETY_KEYS = [
  "safeSpeakUp", "raiseConcerns", "contradicted",
  "attentionCheck2", "contributionSerious", "contributionInfluenced",
  "heldBack",
] as const;

export const BOT_PERCEPTION_KEYS = [
  "botIntrusive", "botHelpful", "botAppropriate",
  "botObserved", "botSupport",
] as const;

/** Name the values of an item group built in `keys` order. */
export function byKey<K extends string, V>(
  keys: readonly K[],
  values: V[],
): Record<K, V> {
  return Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Record<K, V>;
}

// ── formatting ─────────────────────────────────────────────────────

export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function roundOrNull(value: number | null): number | null {
  return value === null ? null : round(value);
}

/** CSV cell for a nullable scalar: empty when null/undefined. */
export function cell(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}
