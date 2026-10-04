import {
  DEFAULT_INTERVENTION_CONFIG,
  normalizeInterventionMode,
} from "@gdm/shared";
import type { Condition, InterventionMode } from "@gdm/shared";

/**
 * The study's delivery-only design: a silent baseline plus public and
 * private nudge delivery. Both nudging arms score dominance with the LLM
 * classifier (`llmMode: "active"`, not a study axis); the baseline never
 * posts and skips the classifier.
 *
 * Only a fresh database receives these rows (the seed never updates an
 * existing condition), and every session snapshots its condition, so the
 * display names below are kept from the original seed: changing them would
 * only make fresh databases disagree with the names existing rows and
 * exports already carry.
 */
export function seedConditions(): Condition[] {
  const arms: {
    id: string;
    name: string;
    mode: InterventionMode;
    llmMode: "off" | "active";
  }[] = [
    { id: "baseline", name: "Baseline", mode: "baseline", llmMode: "off" },
    { id: "public-llm", name: "Public × Rule+LLM", mode: "public", llmMode: "active" },
    { id: "private-llm", name: "Private × Rule+LLM", mode: "private", llmMode: "active" },
  ];

  return arms.map((arm) =>
    normalizeCondition({
      id: arm.id,
      name: arm.name,
      active: true,
      goal: 5,
      durationMinutes: 10,
      groupSize: 3,
      config: {
        ...DEFAULT_INTERVENTION_CONFIG,
        interventionMode: arm.mode,
        llmMode: arm.llmMode,
        scoreWeights: { ...DEFAULT_INTERVENTION_CONFIG.scoreWeights },
      },
    }),
  );
}

export function normalizeCondition(condition: Condition): Condition {
  return {
    ...condition,
    // Admin input can arrive empty/NaN — clamp to values a session can run
    // with (duration 0 would mean a countdown that never starts).
    id: String(condition.id ?? "").trim().slice(0, 128),
    name: String(condition.name ?? "").trim().slice(0, 160),
    active: condition.active === true,
    goal: clampInt(condition.goal, 0, 100_000),
    durationMinutes: clampInt(condition.durationMinutes, 1, 240),
    groupSize: clampInt(condition.groupSize, 2, 50),
    config: {
      ...DEFAULT_INTERVENTION_CONFIG,
      ...condition.config,
      // Conditions stored before the tone axis was retired carry old mode
      // strings like "public-engaging" — fold them onto the delivery axis.
      interventionMode: normalizeInterventionMode(
        condition.config.interventionMode ??
          DEFAULT_INTERVENTION_CONFIG.interventionMode,
      ),
      // External iframe support is opt-in. Old, missing or malformed values
      // always retain the existing structured ranking workspace.
      workspaceMode:
        condition.config.workspaceMode === "etherpad" ? "etherpad" : condition.config.workspaceMode === "external" ? "external" : "ranking",
      scoreWeights: {
        ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
        ...condition.config.scoreWeights,
      },
      dominanceWeights: {
        ...DEFAULT_INTERVENTION_CONFIG.dominanceWeights,
        ...condition.config.dominanceWeights,
      },
      // Warm-up can be 0 (none); fractions allowed like the window.
      protectedStartMinutes: clampNonNegative(
        condition.config.protectedStartMinutes ??
          DEFAULT_INTERVENTION_CONFIG.protectedStartMinutes,
        DEFAULT_INTERVENTION_CONFIG.protectedStartMinutes,
        240,
      ),
      // Fractional minutes allowed (pilots/tests use sub-minute windows).
      contributionWindowMinutes: clampMinutes(
        condition.config.contributionWindowMinutes ??
          DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
        DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
        240,
      ),
      contributionThreshold: clampFraction(
        condition.config.contributionThreshold ??
          DEFAULT_INTERVENTION_CONFIG.contributionThreshold,
        DEFAULT_INTERVENTION_CONFIG.contributionThreshold,
      ),
    },
  };
}

/** Seeded arms first (in seed order), then any other condition by name. */
export function sortConditions(a: Condition, b: Condition): number {
  const order = seedConditions().map((condition) => condition.id);
  const ai = order.indexOf(a.id);
  const bi = order.indexOf(b.id);
  if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

/** Non-negative (possibly fractional) minutes (NaN/empty → the fallback). */
function clampNonNegative(
  value: number,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, value));
}

/** Lower-bound a minutes value at 0.1, keeping fractions (NaN → fallback). */
function clampMinutes(
  value: number,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.1, Math.min(maximum, value));
}

/** Clamp a 0..1 fraction from admin input (NaN/empty → the fallback). */
function clampFraction(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.01, Math.min(1, value));
}

/** Round to an integer and enforce a lower bound (NaN → the bound). */
function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Number.isFinite(rounded)
    ? Math.max(min, Math.min(max, rounded))
    : min;
}
