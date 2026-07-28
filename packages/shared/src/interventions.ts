/**
 * Delivery axis of the study design. Detection (rule-based vs. rule-based +
 * LLM meaningfulness) is the second axis, carried by `llmMode` — together
 * they form the 2×2 + baseline condition set.
 */
export type InterventionMode = "baseline" | "public" | "private";

export type InterventionAudience = "none" | "public" | "private";

/**
 * Map pre-restructure modes (which carried a retired tone suffix, e.g.
 * "public-engaging") onto the current delivery axis, so conditions and
 * checkpoints persisted before the change keep working.
 */
export function normalizeInterventionMode(mode: string): InterventionMode {
  if (mode === "baseline" || mode === "public" || mode === "private") {
    return mode;
  }
  if (mode.startsWith("private")) return "private";
  if (mode.startsWith("public")) return "public";
  return "baseline";
}

export interface ContributionScoreWeights {
  /** Points per message. */
  messages: number;
  /** Points per word. Example: 0.05 means 20 words = 1 point. */
  words: number;
}

/**
 * Weights of the composite dominance score used when the LLM classifier is
 * active: `dominance = share × raw contribution share + meaningfulness ×
 * mean meaningfulness score`. Study protocol: 0.90 / 0.10.
 */
export interface DominanceWeights {
  share: number;
  meaningfulness: number;
}

/**
 * Study condition knobs consumed by the Chat Service bot rules.
 *
 * The current study design has four bot intervention methods.
 * The task content and durable database are intentionally independent from
 * these settings so both can change later without rewriting the rule engine.
 */
export interface InterventionConfig {
  interventionMode: InterventionMode;
  /** Trigger once a participant owns at least this share of contribution. */
  contributionThreshold: number;
  /**
   * Warm-up while people arrive: nothing is counted and no interventions
   * fire. The first contribution window opens when the warm-up ends.
   */
  protectedStartMinutes: number;
  /**
   * Wrap-up window at the end of a discussion: no interventions fire once the
   * time remaining drops to this. May be fractional (the admin dashboard edits
   * it in seconds), so `1.5` means the last 90 seconds. Also drives the
   * participant timer's "wrap up!" cue — see `protectedEndMs`.
   */
  protectedEndMinutes: number;
  /**
   * Self-correction grace period: once a participant's classified message
   * invites others to participate, they cannot be flagged for this many
   * seconds. Only effective while the classifier is active.
   */
  inviteGraceSeconds: number;
  /**
   * Length of the contribution window. At the end of every window the bot
   * evaluates the split over that window and nudges at most once.
   */
  contributionWindowMinutes: number;
  scoreWeights: ContributionScoreWeights;
  dominanceWeights: DominanceWeights;
  /**
   * Semantic classifier mode. `active` folds the meaningfulness score into
   * the dominance score (rule-based + LLM detection arm).
   */
  llmMode?: "off" | "active";
  /**
   * Pilot/testing only: run BOTH detection bots side by side in the room —
   * "Assistant A" (rule-based) and "Assistant B" (rule-based + LLM), each
   * with its own tracker state. Delivery follows the condition's
   * `interventionMode` (public/private); each arm forces its own detection,
   * ignoring the condition's `llmMode`. Never enable for real study sessions.
   */
  comparisonMode?: boolean;
}

export interface ContributionShare {
  userId: string;
  identityName: string;
  messageCount: number;
  wordCount: number;
  score: number;
  /** Raw contribution share (0..1 across the group). Shown in nudges. */
  share: number;
  /** Mean meaningfulness of this member's classified window messages (0..1). */
  meaningfulnessScore: number;
  /** Trigger metric: composite when the LLM is active, otherwise = share. */
  dominanceScore: number;
}

export interface InterventionTarget {
  userId: string;
  identityName: string;
}

export interface InterventionLog {
  id: string;
  sessionId: string;
  roomId: string;
  conditionId: string;
  mode: InterventionMode;
  audience: InterventionAudience;
  timestamp: string;
  trigger: "contribution-threshold";
  threshold: number;
  /** Detection arm that produced this intervention (off = rule-based only). */
  llmMode: "off" | "active";
  contributionWindowMinutes: number;
  contributionSplit: ContributionShare[];
  targets: InterventionTarget[];
  quietMembers: InterventionTarget[];
  message: string;
}

export const DEFAULT_INTERVENTION_CONFIG: InterventionConfig = {
  interventionMode: "public",
  contributionThreshold: 0.4,
  protectedStartMinutes: 3,
  protectedEndMinutes: 2,
  inviteGraceSeconds: 60,
  contributionWindowMinutes: 4,
  scoreWeights: {
    messages: 1,
    words: 0.05,
  },
  dominanceWeights: {
    share: 0.9,
    meaningfulness: 0.1,
  },
  llmMode: "off",
};

export function audienceForMode(mode: InterventionMode): InterventionAudience {
  return mode === "baseline" ? "none" : mode;
}

/**
 * The wrap-up window in milliseconds. Single source of truth shared by the
 * Chat Service (suppresses nudges once the remaining time is within it) and
 * the participant timer (turns "low"/red and shows "wrap up!" at the same
 * point). Falls back to the default when a condition omits the field.
 */
export function protectedEndMs(config: Partial<InterventionConfig>): number {
  const minutes =
    config.protectedEndMinutes ?? DEFAULT_INTERVENTION_CONFIG.protectedEndMinutes;
  return Math.max(0, minutes) * 60_000;
}
