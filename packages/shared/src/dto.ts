/**
 * API contracts between the frontends and the backend services.
 *
 * Pinning these now is what lets the three tracks work in parallel while
 * infra is pending: Chat Service and the frontends code against these shapes
 * and mock the implementation until the real services / Synapse are up.
 */

import type { Condition, Session, Survey } from "./models.js";

// ── Participant Client -> Session Manager ────────────────────────

export interface OpenSessionRequest {
  participantName: string;
  /** Optional: study link may pin a condition; otherwise the manager assigns. */
  conditionId?: string;
}

/** The "session object" returned to the client (sketch: "return session object"). */
export interface OpenSessionResponse {
  session: Session;
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

/** Progress per condition: how many sessions are done vs. still needed. */
export interface ConditionProgress {
  condition: Condition;
  completed: number;
  target: number;
}

export interface UpsertConditionRequest {
  condition: Condition;
  /** How many completed sessions this condition needs. */
  target: number;
}

// ── Admin Dashboard -> Export Service ────────────────────────────

export type ExportFormat = "json" | "csv";

export interface ExportRequest {
  format: ExportFormat;
  /** Restrict to specific conditions; empty / omitted = everything. */
  conditionIds?: string[];
}
