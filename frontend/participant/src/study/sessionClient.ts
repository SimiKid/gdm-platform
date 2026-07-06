import type {
  OpenSessionRequest,
  OpenSessionResponse,
  Session,
  StudySettings,
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
  /** Assign a condition & session for a validated participant (Waiting Room). */
  openSession(req: OpenSessionRequest): Promise<OpenSessionResponse>;
  /** Poll a session for its live participant count and roomId once ready. */
  getSession(id: string): Promise<Session>;
  /** Persist an entry/exit survey. */
  submitSurvey(req: SubmitSurveyRequest): Promise<void>;
  /** Mark the session completed when the discussion timer ends. */
  completeSession(id: string): Promise<void>;
  /** Study-wide settings, e.g. the researcher-set compensation link. */
  getStudySettings(): Promise<StudySettings>;
}

/**
 * Base URL of the Session Manager. Dev: the backend runs on :3001. The
 * container build sets VITE_SESSION_MANAGER_URL=/api so nginx proxies it.
 */
const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";

/** Real implementation — enabled once the Session Manager is running. */
export const httpSessionManager: SessionManagerClient = {
  async openSession(req) {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`openSession failed: ${res.status}`);
    return (await res.json()) as OpenSessionResponse;
  },
  async getSession(id) {
    const res = await fetch(`${API_BASE}/sessions/${id}`);
    if (!res.ok) throw new Error(`getSession failed: ${res.status}`);
    return (await res.json()) as Session;
  },
  async submitSurvey(req) {
    const res = await fetch(`${API_BASE}/surveys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`submitSurvey failed: ${res.status}`);
  },
  async completeSession(id) {
    const res = await fetch(`${API_BASE}/sessions/${id}/complete`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`completeSession failed: ${res.status}`);
  },
  async getStudySettings() {
    const res = await fetch(`${API_BASE}/settings`);
    if (!res.ok) throw new Error(`getStudySettings failed: ${res.status}`);
    return (await res.json()) as StudySettings;
  },
};
