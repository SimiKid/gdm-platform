/**
 * The study's single design axis: how nudges are delivered. The condition set
 * is `baseline` (no nudges), `public-llm` and `private-llm`; both nudging arms
 * use the same rule + LLM detection (`llmMode: "active"`).
 */
export type InterventionMode = "baseline" | "public" | "private";

export type InterventionAudience = "none" | "public" | "private";

/** Shared artifact shown beside the group chat. */
export type WorkspaceMode = "ranking" | "external" | "etherpad";

/**
 * Future provider-owned workspace embedded beside the chat.
 *
 * The platform deliberately does not create documents or collect their
 * contents: a provider integration must supply a safe, group-specific URL.
 * Until then, external mode renders an explicit not-configured placeholder.
 */
export interface ExternalWorkspaceConfig {
  embedUrl?: string;
  title?: string;
}

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
 * The current study design has two bot intervention methods (public and
 * private nudges) plus a silent baseline. The task content and durable
 * database are intentionally independent from these settings so both can
 * change later without rewriting the rule engine.
 */
export interface InterventionConfig {
  /**
   * Shared artifact shown beside the chat. Missing/unknown values normalize
   * to `ranking`, preserving every existing study condition.
   */
  workspaceMode?: WorkspaceMode;
  /** Optional future iframe provider configuration. Not editable yet. */
  externalWorkspace?: ExternalWorkspaceConfig;
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
   * the dominance score (rule + LLM detection) and is what both nudging arms
   * use. `off` (raw contribution share, no classifier calls) is reserved for
   * the silent baseline, where nothing is delivered anyway. Not a study axis.
   */
  llmMode?: "off" | "active";
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
  /** Detection mode that produced this intervention. */
  llmMode: "off" | "active";
  contributionWindowMinutes: number;
  contributionSplit: ContributionShare[];
  targets: InterventionTarget[];
  quietMembers: InterventionTarget[];
  message: string;
}

/**
 * Why a contribution-window boundary did or did not produce a nudge.
 *
 * - `nudged` — a nudge fired; `interventionId` links the InterventionLog.
 * - `no-target` — split computed, nobody over the threshold.
 * - `grace-suppressed` — someone was over the threshold but every candidate
 *   was inside the invite grace period.
 * - `baseline-suppressed` — baseline arm: a candidate existed but the
 *   audience is "none", so nothing was delivered (counterfactual record).
 * - `warm-up` / `wrap-up` — boundary inside a protected phase; no split.
 * - `too-few-participants` — fewer than 2 joined participants; no split.
 */
export type WindowOutcome =
  | "nudged"
  | "no-target"
  | "grace-suppressed"
  | "baseline-suppressed"
  | "warm-up"
  | "wrap-up"
  | "too-few-participants";

/**
 * One record per evaluated contribution-window boundary, fired or not.
 * Interventions only capture windows that produced a nudge; these capture
 * every boundary, so dominance dynamics are comparable across all arms —
 * including baseline, which never delivers a nudge.
 */
export interface WindowEvaluation {
  id: string;
  sessionId: string;
  conditionId: string;
  /** 0-based index on the session's window grid (grid starts at warm-up end). */
  windowIndex: number;
  windowStart: string; // ISO 8601
  windowEnd: string; // ISO 8601
  contributionWindowMinutes: number;
  llmMode: "off" | "active";
  threshold: number;
  outcome: WindowOutcome;
  /** Per-participant split over this window; [] when no split was computed. */
  contributionSplit: ContributionShare[];
  /** Members over the threshold BEFORE grace filtering (would-have-fired). */
  candidateTargets: InterventionTarget[];
  /** Highest dominance score in the split; null when no split was computed. */
  maxDominanceScore: number | null;
  /** Links the InterventionLog when outcome is "nudged". */
  interventionId: string | null;
}

export const DEFAULT_INTERVENTION_CONFIG: InterventionConfig = {
  workspaceMode: "ranking",
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
