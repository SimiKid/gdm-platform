import type {
  InterventionConfig,
  InterventionLog,
  WindowEvaluation,
} from "./interventions.js";

/**
 * Domain models for the GDM Study Platform.
 *
 * These mirror the entities in the architecture sketch and wireframe
 * (Session, Chat, Message, Participant, Condition, the Expedition-Mars
 * ranking task) and are the shared contract between the backend services
 * and the frontends. Persistence shape (columns, relations) is owned by the
 * Session Manager's repository layer; these are the transport/domain types
 * everyone codes against.
 */

/** A named survey answer set (in-app entry or exit questionnaire). */
export interface Survey {
  /**
   * Question id -> answer. Kept generic until the instruments are fixed.
   * `string[]` carries the individual Expedition-Mars ranking (ordered ids).
   */
  answers: Record<string, string | number | boolean | string[]>;
  submittedAt: string; // ISO 8601
}

/** Prolific identifiers appended to the external study URL. */
export interface ProlificIdentity {
  /** Pseudonymous participant identifier (`PROLIFIC_PID`). */
  participantId: string;
  /** Prolific study identifier (`STUDY_ID`). */
  studyId: string;
  /** Unique submission identifier (`SESSION_ID`). */
  sessionId: string;
}

/** First server-side contact from a Prolific submission. */
export interface ProlificArrival extends ProlificIdentity {
  arrivedAt: string;
  /** Set once the submission claims a seat in a study session. */
  participantRecordId?: string;
  /** Last durable participant-journey milestone acknowledged by the backend. */
  stage: ParticipationStage;
  stageUpdatedAt: string;
  lastSeenAt: string;
  /** Set exactly once when the participant leaves or completes the study. */
  outcome?: ParticipationOutcome;
  outcomeReason?: string;
  endedAt?: string;
  elapsedSeconds?: number;
  compensationKind?: CompensationKind;
  compensationAmountPence?: number;
  prolificActionStatus?: ProlificActionStatus;
}

export type ParticipationStage =
  | "arrived"
  | "consent"
  | "entry"
  | "waiting"
  | "chat"
  | "exit"
  | "done"
  | "terminated";

export type ParticipationOutcome =
  | "completed"
  | "declined_consent"
  | "ineligible"
  | "voluntary_withdrawal"
  | "connection_timeout"
  | "unmatched"
  | "technical_failure"
  | "participant_dropout"
  | "group_aborted";

export type CompensationKind = "none" | "partial" | "full" | "manual_review";

export type ProlificActionStatus =
  | "not_required"
  | "pending"
  | "return_requested"
  | "bonus_prepared"
  | "payment_in_progress"
  | "payment_uncertain"
  | "payment_submitted"
  | "resolved_manually"
  | "failed";

/** Admin-facing lifecycle/payment view; identifiers remain outside research exports. */
export interface ParticipationOutcomeRecord extends ProlificArrival {
  id: string;
  returnRequestedAt?: string;
  bonusBatchId?: string;
  paymentSubmittedAt?: string;
  actionError?: string;
}

/** A member of a hiring committee taking part in a study session. */
export interface Participant {
  id: string;
  name: string;
  /** Per-participant tracking URL token (the "individual URL" in the wireframe). */
  trackingToken: string;
  /** Present when the participant entered through Prolific. */
  prolific?: ProlificIdentity;
  /** Individual completion, separate from the group session lifecycle. */
  completedAt?: string;
  /**
   * Matrix user id once credentials are provisioned. Messages, interventions
   * and contribution splits key on this, so exports need it to attribute
   * activity to a participant. Never exposed to other participants
   * (PublicParticipant strips it).
   */
  matrixUserId?: string;
  entrySurvey?: Survey;
  exitSurvey?: Survey;
}

/** Emoji / acknowledgment reaction attached to a message. */
export interface Reaction {
  /** Matrix annotation event id, used to make toggles/restarts lossless. */
  eventId?: string;
  key: string; // e.g. "👍" or "m.acknowledged"
  senderId: string;
  timestamp: string; // ISO 8601
}

/** Immutable Matrix reaction event plus an optional later redaction. */
export interface RecordedReaction extends Reaction {
  eventId: string;
  messageId: string;
  redacted: boolean;
  redactionEventId?: string;
  redactedAt?: string;
}

/**
 * A single chat message (sketch: "Nachricht").
 *
 * Participants CANNOT private-message each other (wireframe: "No private
 * messages"). recipientId is therefore bot-only: set when the *bot* sends a
 * private nudge visible to a single participant; omit / null for normal
 * messages sent to the whole group room.
 */
export interface Message {
  id: string;
  timestamp: string; // ISO 8601
  senderId: string;
  recipientId?: string | null;
  text: string;
  reactions: Reaction[];
}

/** The ordered message log of a session (sketch: "Chat"). */
export interface Chat {
  messages: Message[];
}

/** Static briefing shown alongside the chat (wireframe: "Briefing" panel). */
export interface Briefing {
  title: string;
  /** Rendered as HTML in the chat room. */
  html: string;
}

/** One rankable item in the Expedition-Mars exercise. */
export interface RankingItem {
  id: string;
  label: string;
}

/**
 * The Expedition-Mars task: the fixed set of items the group ranks.
 * (Replaces the earlier "shared Etherpad" resource idea.)
 */
export interface RankingTask {
  id: string;
  title: string;
  items: RankingItem[];
}

/**
 * The group's live shared ranking — a single ordered list of item ids that
 * every participant can edit, synced in real time to the others over Matrix.
 * `order[0]` is rank #1.
 */
export interface Ranking {
  /** Matrix event id, attached by the recorder for lossless deduplication. */
  eventId?: string;
  taskId: string;
  order: string[]; // RankingItem ids, best-to-worst
  updatedAt: string; // ISO 8601
  updatedBy: string; // participant/bot id of the last editor
  /** Optional movement metadata used for collaboration feedback and analysis. */
  movement?: { itemId: string; from: number; to: number };
}

export type BehavioralEventType =
  | "typing-start"
  | "typing-stop"
  | "tab-hidden"
  | "tab-visible"
  | "cursor-activity"
  | "ranking-move";

/** Persisted interaction telemetry emitted during the group task. */
export interface BehavioralEvent {
  id: string;
  type: BehavioralEventType;
  participantId: string;
  timestamp: string;
  durationMs?: number;
  payload?: Record<string, string | number | boolean | string[]>;
}

/** One true/false structural indicator plus the model's one-sentence reason. */
export interface ClassifierIndicator {
  value: boolean;
  reason: string;
}

/**
 * Auditable result of one meaningfulness classification request.
 *
 * The first three indicators average into `meaningfulnessScore` (0..1).
 * `invitesParticipation` is tracked separately — it feeds the dominant
 * contributor's self-correction grace period, never the score.
 */
export interface ContributionClassification {
  messageId: string;
  senderId: string;
  classifiedAt: string;
  /** Reacts to, builds on, or directly refers to a prior message/member. */
  respondsToPrior: ClassifierIndicator;
  /** Explicitly names one or more ranking-task items. */
  referencesTaskItem: ClassifierIndicator;
  /** Explicit stance, proposal, or structured discourse move. */
  hasDiscussionStructure: ClassifierIndicator;
  /** Explicitly invites another (named or unnamed) member to contribute. */
  invitesParticipation: ClassifierIndicator;
  /** Mean of the three meaningfulness indicators, 0..1. */
  meaningfulnessScore: number;
  model: string;
  promptVersion: string;
  prompt: string;
  rawOutput: string;
}

/**
 * Record of a classification request that produced no usable result
 * (missing API key, API error, malformed output). Persisted so exports can
 * report classification coverage instead of silently under-counting.
 */
export interface ClassificationFailure {
  messageId: string;
  senderId: string;
  failedAt: string; // ISO 8601
  model: string;
  promptVersion: string;
  /** "missing-api-key" or the truncated error text. */
  error: string;
}

/** A poll, initialized by the bot (wireframe: "Polls initialized by bot"). */
export interface Poll {
  id: string;
  question: string;
  options: string[];
  /** option index -> voter ids. */
  votes: Record<number, string[]>;
  closed: boolean;
}

/**
 * An experimental condition (wireframe: Settings — Condition 1/2/3 with an
 * Active toggle, a Goal, discussion time and group size).
 */
export interface Condition {
  id: string;
  name: string;
  /** Whether the Waiting Room may still assign this condition. */
  active: boolean;
  /** Target number of completed sessions before auto-off. */
  goal: number;
  /** Discussion time budget for the chat room. */
  durationMinutes: number;
  /** Required participants per session ("# People"). */
  groupSize: number;
  /** Condition-specific knobs consumed by the bot. */
  config: InterventionConfig & Record<string, unknown>;
}

/**
 * Study-wide settings the researcher edits in the admin dashboard
 * (wireframe: Settings). Applied globally, not per condition.
 */
export interface StudySettings {
  /**
   * Where the debriefing page's "Claim compensation" button sends
   * participants (payment / Prolific completion link). Empty = the
   * participant app falls back to its build-time default.
   */
  compensationUrl: string;
  /** Prolific paths used for non-happy terminal outcomes. */
  noConsentUrl: string;
  ineligibleUrl: string;
  withdrawalUrl: string;
  unmatchedUrl: string;
  technicalFailureUrl: string;
}

/** Which nudge behavior the bot runs for a session. */
export interface BotConfig {
  /** True when the semantic classifier is enabled for this session. */
  llmEnabled: boolean;
  condition: Condition;
}

export type SessionStatus =
  | "waiting" // in the waiting room, gathering participants
  | "provisioning" // full group; private room/bot access is being prepared
  | "running" // chat room live
  | "completed"
  | "aborted";

/**
 * A single run of a group decision-making session (sketch: "Session").
 * Owns its participants, the chat log, the assigned condition, the shared
 * ranking and bot config.
 */
export interface Session {
  id: string;
  status: SessionStatus;
  /**
   * The study round open when this session was created (1, 2, …). Stamped
   * once; sessions never change rounds. Running sessions finish in their
   * round even after the researcher starts a new one.
   */
  roundId: number;
  condition: Condition;
  bot: BotConfig;
  participants: Participant[];
  chat: Chat;
  briefing: Briefing;
  rankingTask: RankingTask;
  /** The group's current shared ranking (evolves live during the session). */
  ranking: Ranking;
  /** Every shared-ranking state during the session, oldest → newest. */
  rankingHistory?: Ranking[];
  /** Bot interventions emitted during the live session. */
  interventions: InterventionLog[];
  /** Typing, visibility, and ranking movement telemetry. */
  behavioralEvents: BehavioralEvent[];
  /** Per-message semantic judgments when the LLM classifier is enabled. */
  contributionClassifications: ContributionClassification[];
  /** One record per evaluated contribution-window boundary, fired or not. */
  windowEvaluations?: WindowEvaluation[];
  /** Classification requests that failed (coverage accounting). */
  classificationFailures?: ClassificationFailure[];
  /** Internal restart checkpoint metadata; not used by participant clients. */
  processedEventIds?: string[];
  /** Reaction event ids later redacted/toggled off; retained as tombstones. */
  redactedReactionEventIds?: string[];
  /** Full reaction audit trail, including toggled-off annotations. */
  reactionEvents?: RecordedReaction[];
  runtimeState?: Record<string, unknown>;
  /** Last durable Chat Service snapshot revision (internal recovery metadata). */
  checkpointRevision?: number;
  polls: Poll[];
  /** Copied from the condition at assignment time; drives the chat timer. */
  durationMinutes: number;
  /** Matrix room id backing this session, once provisioned. */
  roomId?: string;
  /** Durable server deadline after which an incomplete group is terminated. */
  waitingDeadlineAt?: string;
  createdAt: string; // ISO 8601
  startedAt?: string; // ISO 8601 — chat room opened; timer start
  completedAt?: string; // ISO 8601
}
