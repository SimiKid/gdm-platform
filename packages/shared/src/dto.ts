/**
 * API contracts between the frontends and the backend services.
 *
 * Build target: the local stack in infra/docker-compose.yml. Synapse runs
 * locally, so live chat, reactions and shared-ranking edits are developed
 * against the REAL local Matrix instance — not mocked. They ride on Matrix
 * events (see MATRIX_EVENT_TYPES below), not these REST DTOs.
 *
 * Only the still-pending infra gets an interface/mock: the research DB
 * (persistence) and the bot appservice registration. These DTOs cover session
 * lifecycle, surveys, condition config and export.
 */

import type { Condition, Message, Ranking, Session, Survey } from "./models.js";

// ── Participant Client -> Session Manager ────────────────────────

/** Entry point from the individual tracking URL (wireframe: Recruiting → Link). */
export interface OpenSessionRequest {
  /** The per-participant tracking token from the individual URL. */
  trackingToken: string;
  participantName: string;
}

/** The "session object" returned to the client (sketch: "return session object"). */
export interface OpenSessionResponse {
  session: Session;
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

// ── Admin Dashboard -> Export Service ────────────────────────────

export type ExportFormat = "json" | "csv";

export interface ExportRequest {
  format: ExportFormat;
  /** Restrict to specific conditions; empty / omitted = everything. */
  conditionIds?: string[];
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
} as const;

/**
 * Custom content key on a bot `m.room.message`. When present, the message is a
 * private nudge meant for that participant only — the client renders it solely
 * to the recipient (soft privacy; the event still exists in the room for the
 * research record).
 */
export const GDM_RECIPIENT_KEY = "de.gdm.recipient";

/** Payload of a `de.gdm.ranking` event (one participant reordered the list). */
export interface RankingUpdateEvent {
  ranking: Ranking;
}

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
}
