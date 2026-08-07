import type {
  CompleteParticipantResponse,
  OpenSessionRequest,
  OpenSessionResponse,
  ProlificIdentity,
  ProlificResumeResponse,
  PublicSession,
  RecordProlificArrivalResponse,
  SubmitSurveyRequest,
} from "@gdm/shared";

/**
 * Client for the Session Manager backend.
 *
 * The Session Manager isn't built yet (research-DB persistence is the pending
 * infra), so the participant app codes against this interface and uses the
 * mock below. Swap in a `fetch`-based implementation once the service is up —
 * no call sites change. Matrix itself is NOT mocked: the mock returns creds
 * for the real local Synapse.
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
  /** Mark the session completed when the discussion timer ends. */
  completeSession(id: string): Promise<void>;
  /** Mark this participant complete after their exit survey was saved. */
  completeParticipant(
    sessionId: string,
    participantId: string,
  ): Promise<CompleteParticipantResponse>;
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
