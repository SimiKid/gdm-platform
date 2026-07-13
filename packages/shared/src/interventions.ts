export type InterventionMode =
  | "baseline"
  | "public-neutral"
  | "public-engaging"
  | "private-neutral"
  | "private-engaging";

export type InterventionAudience = "none" | "public" | "private";
export type InterventionTone = "none" | "neutral" | "engaging";

export interface ContributionScoreWeights {
  /** Points per message. */
  messages: number;
  /** Points per character. Example: 0.01 means 100 chars = 1 point. */
  characters: number;
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
  /** No interventions at the start of a discussion. */
  protectedStartMinutes: number;
  /** No interventions near the end of a discussion. */
  protectedEndMinutes: number;
  /** Minimum time between interventions for the same target. */
  interventionWindowMinutes: number;
  /** Rolling message window used to calculate the contribution split. */
  contributionWindowMinutes: number;
  scoreWeights: ContributionScoreWeights;
}

export interface ContributionShare {
  userId: string;
  identityName: string;
  messageCount: number;
  characterCount: number;
  score: number;
  share: number;
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
  tone: InterventionTone;
  timestamp: string;
  trigger: "contribution-threshold";
  threshold: number;
  contributionWindowMinutes: number;
  contributionSplit: ContributionShare[];
  targets: InterventionTarget[];
  quietMembers: InterventionTarget[];
  message: string;
}

export const DEFAULT_INTERVENTION_CONFIG: InterventionConfig = {
  interventionMode: "public-neutral",
  contributionThreshold: 0.4,
  protectedStartMinutes: 3,
  protectedEndMinutes: 2,
  interventionWindowMinutes: 4,
  contributionWindowMinutes: 4,
  scoreWeights: {
    messages: 1,
    characters: 0.01,
  },
};

export function audienceForMode(mode: InterventionMode): InterventionAudience {
  if (mode === "baseline") return "none";
  return mode.startsWith("private") ? "private" : "public";
}

export function toneForMode(mode: InterventionMode): InterventionTone {
  if (mode === "baseline") return "none";
  return mode.endsWith("engaging") ? "engaging" : "neutral";
}
