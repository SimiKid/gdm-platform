/**
 * API contracts between the frontends and the backend services.
 *
 * Build target: the local stack in infra/docker-compose.yml. Synapse runs
 * locally, so live chat, reactions and shared-ranking edits are developed
 * against the REAL local Matrix instance — not mocked. They ride on Matrix
 * events (see MATRIX_EVENT_TYPES below), not these REST DTOs.
 *
 * Research persistence is owned by the Session Manager. The remaining mocked
 * boundary is the future bot appservice registration. These DTOs cover session
 * lifecycle, surveys, condition config and export.
 */

import type {
  InterventionLog,
  InterventionMode,
  WindowEvaluation,
} from "./interventions.js";
import type {
  BehavioralEvent,
  ClassificationFailure,
  Condition,
  ContributionClassification,
  Message,
  Ranking,
  Session,
  SessionStatus,
  StudySettings,
  Survey,
} from "./models.js";

// ── Participant Client -> Session Manager ────────────────────────

/** Entry point from the individual tracking URL (wireframe: Recruiting → Link). */
export interface OpenSessionRequest {
  /** The per-participant tracking token from the individual URL. */
  trackingToken: string;
  participantName: string;
  /** Pilot/testing only: force this participant into a specific condition. */
  conditionId?: string;
}

/**
 * A participant as exposed to *other* participants: identity only, never the
 * tracking token or survey answers (the Waiting Room polls the session, so
 * anything in here is visible in every participant's network tab).
 */
export interface PublicParticipant {
  id: string;
  name: string;
}

/** A session as returned to participant clients — participants sanitized. */
export type PublicSession = Omit<
  Session,
  | "participants"
  | "behavioralEvents"
  | "contributionClassifications"
  | "windowEvaluations"
  | "classificationFailures"
  | "processedEventIds"
  | "runtimeState"
> & {
  participants: PublicParticipant[];
};

/** The "session object" returned to the client (sketch: "return session object"). */
export interface OpenSessionResponse {
  session: PublicSession;
  participantId: string;
  /** Matrix credentials the client uses to join the room in real time. */
  matrix: {
    homeserverUrl: string;
    userId: string;
    accessToken: string;
    roomId: string;
  };
}

export interface SubmitSurveyRequest {
  sessionId: string;
  participantId: string;
  kind: "entry" | "exit";
  survey: Survey;
}

// ── Admin Dashboard -> Session Manager ───────────────────────────

/** Progress per condition: how many sessions are done vs. the goal. */
export interface ConditionProgress {
  condition: Condition;
  completed: number;
  /** Mirrors condition.goal; auto-off triggers once completed >= goal. */
  goal: number;
}

/** Create or update a condition (goal/active/time/#people live on Condition). */
export interface UpsertConditionRequest {
  condition: Condition;
}

/** Update study-wide settings (e.g. the compensation link). */
export interface UpdateStudySettingsRequest {
  settings: Partial<StudySettings>;
}

export interface SessionSummary {
  id: string;
  status: SessionStatus;
  conditionId: string;
  conditionName: string;
  participantCount: number;
  groupSize: number;
  messageCount: number;
  interventionCount: number;
  rankingEditCount: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  roomId?: string;
}

export interface InterventionSummary {
  sessionId: string;
  conditionId: string;
  timestamp: string;
  mode: InterventionLog["mode"];
  audience: InterventionLog["audience"];
  targets: InterventionLog["targets"];
  quietMembers: InterventionLog["quietMembers"];
  contributionSplit: InterventionLog["contributionSplit"];
  message: string;
}

// ── Admin Dashboard -> Export Service ────────────────────────────

export interface ExportBundle {
  generatedAt: string;
  sessions: Session[];
}

/**
 * Per-condition descriptives for the dashboard Results tab. Means are
 * computed over completed sessions only; session counts are broken out by
 * status. `null` means "no data yet", never zero.
 */
export interface ConditionReportSummary {
  conditionId: string;
  conditionName: string;
  interventionMode: InterventionMode;
  llmMode: "off" | "active";
  sessionsCompleted: number;
  sessionsAborted: number;
  sessionsRunning: number;
  participants: number;
  entrySurveys: number;
  exitSurveys: number;
  meanGroupRankingError: number | null;
  meanIndividualRankingError: number | null;
  meanExitRankingError: number | null;
  meanSatisfaction: number | null;
  meanFairness: number | null;
  meanFeltHeard: number | null;
  /** Mean over sessions of the SD of contribution shares (0 = equal). */
  meanShareStdDev: number | null;
  /** Mean over sessions of the Gini coefficient of contribution scores. */
  meanShareGini: number | null;
  nudgesTotal: number;
  nudgesPerSessionMean: number | null;
  windowsEvaluated: number;
  windowsNudged: number;
}

export interface ReportsSummaryResponse {
  generatedAt: string;
  conditions: ConditionReportSummary[];
}

// ── Real-time (Matrix custom events) ─────────────────────────────

/**
 * Custom Matrix event types used inside a session room. Chat itself uses the
 * standard m.room.message / m.reaction; these carry the study-specific state.
 */
export const MATRIX_EVENT_TYPES = {
  /** Full shared ranking after an edit; payload is a {@link Ranking}. */
  ranking: "de.gdm.ranking",
  /** Bot-initiated poll create/update. */
  poll: "de.gdm.poll",
  /** Timer / "5 min left" and other session lifecycle signals. */
  sessionSignal: "de.gdm.session_signal",
  /** Durable interaction telemetry (typing intervals, visibility changes). */
  behavior: "de.gdm.behavior",
} as const;

/**
 * Custom content key on a bot `m.room.message`. When present, the message is a
 * private nudge meant for that participant only — the client renders it solely
 * to the recipient (soft privacy; the event still exists in the room for the
 * research record).
 */
export const GDM_RECIPIENT_KEY = "de.gdm.recipient";

// ── Session Manager <-> Chat Service ─────────────────────────────

/**
 * Session Manager hands a freshly-provisioned live session to the Chat Service
 * to run (bot rules, relay, timer). The Chat Service joins the room itself.
 */
export interface StartSessionNotification {
  sessionId: string;
  roomId: string;
  condition: Condition;
  durationMinutes: number;
  startedAt?: string;
  checkpoint?: RuntimeCheckpoint;
}

/** Durable snapshot used while a live session is still running. */
export interface RuntimeCheckpoint {
  messages: Message[];
  rankingHistory: Ranking[];
  interventions: InterventionLog[];
  behavioralEvents: BehavioralEvent[];
  contributionClassifications: ContributionClassification[];
  /** Optional: checkpoints written before this field existed omit it. */
  windowEvaluations?: WindowEvaluation[];
  /** Optional: checkpoints written before this field existed omit it. */
  classificationFailures?: ClassificationFailure[];
  processedEventIds: string[];
  ruleState: Record<string, unknown>;
}

export interface RecoverSessionsRequest {
  botUserId: string;
  /** Comparison-mode bot users (Assistant A/B) to re-invite where needed. */
  comparisonBotUserIds?: string[];
}

/**
 * Chat Service returns the collected discussion data to the Session Manager at
 * session end, to be persisted in the research DB.
 */
export interface FinalizeSessionRequest {
  /** Full chat log (messages carry their aggregated reactions). */
  messages: Message[];
  /** Every shared-ranking state during the session, oldest → newest. */
  rankingHistory: Ranking[];
  /** Bot interventions emitted during the session. */
  interventions?: InterventionLog[];
  behavioralEvents?: BehavioralEvent[];
  contributionClassifications?: ContributionClassification[];
  windowEvaluations?: WindowEvaluation[];
  classificationFailures?: ClassificationFailure[];
  processedEventIds?: string[];
  ruleState?: Record<string, unknown>;
}

export type CheckpointSessionRequest = FinalizeSessionRequest;

/** One participant's aggregate activity for analysis/export. */
export interface ContributionAggregate {
  sessionId: string;
  conditionId: string;
  participantId: string;
  messageCount: number;
  characterCount: number;
  reactionCount: number;
  rankingMoveCount: number;
  typingDurationMs: number;
  respondsToPriorCount: number;
  referencesTaskItemCount: number;
  hasDiscussionStructureCount: number;
  invitesParticipationCount: number;
  /** Mean meaningfulnessScore across this participant's classified messages. */
  meaningfulnessScoreMean: number;
}
