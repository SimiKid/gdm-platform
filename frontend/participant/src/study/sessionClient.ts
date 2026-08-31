import type {
  CompleteParticipantResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ParticipationOutcomeResponse,
  ParticipationStage,
  ProlificIdentity,
  ProlificResumeResponse,
  PublicSession,
  RecordProlificArrivalResponse,
  SubmitSurveyRequest,
} from "@gdm/shared";

/**
 * Client for the Session Manager backend.
 *
 * Keeping the HTTP boundary behind this interface makes participant-flow tests
 * deterministic while production uses the fetch implementation below.
 */
export interface SessionManagerClient {
  /** Persist Prolific identity as soon as the external study opens. */
  recordProlificArrival(
    prolific: ProlificIdentity,
  ): Promise<RecordProlificArrivalResponse>;
  /** Restore a previously claimed Prolific seat after closing/reopening. */
  resumeProlific(
    prolific: ProlificIdentity,
  ): Promise<ProlificResumeResponse | null>;
  /** Assign a condition & session for a validated participant (Waiting Room). */
  openSession(req: OpenSessionRequest): Promise<OpenSessionResponse>;
  /** Poll a session for its live participant count and roomId once ready. */
  getSession(id: string): Promise<PublicSession>;
  /** Persist an entry/exit survey. */
  submitSurvey(req: SubmitSurveyRequest): Promise<void>;
  /** Persist optional debrief feedback into the exit survey. */
  submitDebriefFeedback(
    sessionId: string,
    participantId: string,
    feedback: string,
  ): Promise<void>;
  /** Mark the session completed when the discussion timer ends. */
  completeSession(id: string): Promise<void>;
  /** Mark this participant complete after their exit survey was saved. */
  completeParticipant(
    sessionId: string,
    participantId: string,
  ): Promise<CompleteParticipantResponse>;
  recordParticipationProgress(
    prolific: ProlificIdentity,
    stage: Exclude<ParticipationStage, "done" | "terminated">,
  ): Promise<void>;
  terminateParticipation(
    prolific: ProlificIdentity,
    outcome: "declined_consent" | "ineligible" | "voluntary_withdrawal",
    reason?: string,
  ): Promise<ParticipationOutcomeResponse>;
  getParticipationOutcome(
    prolific: ProlificIdentity,
  ): Promise<ParticipationOutcomeResponse | null>;
}

/**
 * Base URL of the Session Manager. Dev: the backend runs on :3001. The
 * container build sets VITE_SESSION_MANAGER_URL=/api so nginx proxies it.
 */
const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";

const PARTICIPANT_TOKEN_KEY = "gdm-tracking-token";
const REQUEST_TIMEOUT_MS = 15_000;

function participantHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  let token = "";
  try {
    token = sessionStorage.getItem(PARTICIPANT_TOKEN_KEY) ?? "";
  } catch {
    /* A missing token produces a normal 401 response. */
  }
  return {
    ...headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function request(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Real implementation — enabled once the Session Manager is running. */
export const httpSessionManager: SessionManagerClient = {
  async recordProlificArrival(prolific) {
    const res = await request(`${API_BASE}/prolific/arrivals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific }),
    });
    if (!res.ok) {
      throw new Error(`recordProlificArrival failed: ${res.status}`);
    }
    return (await res.json()) as RecordProlificArrivalResponse;
  },
  async resumeProlific(prolific) {
    const res = await request(`${API_BASE}/prolific/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific }),
    });
    if (!res.ok) throw new Error(`resumeProlific failed: ${res.status}`);
    // Nest sends an empty response body when the service returns null. That is
    // the normal first-visit case, not malformed JSON or a validation failure.
    const body = await res.text();
    if (!body.trim()) return null;
    return JSON.parse(body) as ProlificResumeResponse | null;
  },
  async recordParticipationProgress(prolific, stage) {
    const res = await request(`${API_BASE}/prolific/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific, stage }),
    });
    if (!res.ok) throw new Error(`recordParticipationProgress failed: ${res.status}`);
  },
  async terminateParticipation(prolific, outcome, reason) {
    const res = await request(`${API_BASE}/prolific/terminate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific, outcome, reason }),
    });
    if (!res.ok) throw new Error(`terminateParticipation failed: ${res.status}`);
    return (await res.json()) as ParticipationOutcomeResponse;
  },
  async getParticipationOutcome(prolific) {
    const res = await request(`${API_BASE}/prolific/outcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prolific }),
    });
    if (!res.ok) throw new Error(`getParticipationOutcome failed: ${res.status}`);
    const body = await res.text();
    return body.trim() ? (JSON.parse(body) as ParticipationOutcomeResponse | null) : null;
  },
  async openSession(req) {
    const res = await request(`${API_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`openSession failed: ${res.status}`);
    return (await res.json()) as OpenSessionResponse;
  },
  async getSession(id) {
    const res = await request(`${API_BASE}/sessions/${id}`, {
      headers: participantHeaders(),
    });
    if (!res.ok) throw new Error(`getSession failed: ${res.status}`);
    return (await res.json()) as PublicSession;
  },
  async submitSurvey(req) {
    const res = await request(`${API_BASE}/surveys`, {
      method: "POST",
      headers: participantHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`submitSurvey failed: ${res.status}`);
  },
  async submitDebriefFeedback(sessionId: string, participantId: string, feedback: string) {
    const res = await request(`${API_BASE}/surveys/debrief-feedback`, {
      method: "POST",
      headers: participantHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId, participantId, feedback }),
    });
    if (!res.ok) throw new Error(`submitDebriefFeedback failed: ${res.status}`);
  },
  async completeSession(id) {
    const res = await request(`${API_BASE}/sessions/${id}/complete`, {
      method: "POST",
      headers: participantHeaders(),
    });
    if (!res.ok) throw new Error(`completeSession failed: ${res.status}`);
  },
  async completeParticipant(sessionId, participantId) {
    const res = await request(
      `${API_BASE}/sessions/${sessionId}/participants/${participantId}/complete`,
      { method: "POST", headers: participantHeaders() },
    );
    if (!res.ok) {
      throw new Error(`completeParticipant failed: ${res.status}`);
    }
    return (await res.json()) as CompleteParticipantResponse;
  },
};
