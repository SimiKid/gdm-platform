/**
 * Session Manager access for the dashboard. All researcher endpoints are
 * protected by ADMIN_API_TOKEN on the backend; the token is entered once in
 * the dashboard and kept on this browser until it is replaced or cleared.
 * When the backend runs without a token (local dev), everything works without
 * entering one.
 */

export const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
export const PARTICIPANT_BASE =
  import.meta.env.VITE_PARTICIPANT_URL ?? "http://localhost:3000";

const TOKEN_KEY = "gdm-admin-token";

export function getAdminToken(): string {
  try {
    const current = localStorage.getItem(TOKEN_KEY);
    if (current) return current;
    // Migrate credentials saved by releases that scoped the token to one tab.
    const legacy = sessionStorage.getItem(TOKEN_KEY) ?? "";
    if (legacy) {
      localStorage.setItem(TOKEN_KEY, legacy);
      sessionStorage.removeItem(TOKEN_KEY);
    }
    return legacy;
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** fetch against the Session Manager with the admin token attached. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
}

/**
 * Conditions created by the automated E2E suite (unique `e2e-…` id per run).
 * They are test residue, not study arms — the UI groups them separately and
 * flags them when active (an active test arm would recruit real participants).
 */
export function isTestCondition(conditionId: string): boolean {
  return conditionId.startsWith("e2e-");
}

/**
 * Safe href used by authenticated download links. Credentials are never
 * included in URLs, browser history, or referrers.
 */
export function exportUrl(path: string, query: string): string {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

/** Relative version of exportUrl for apiFetch(). */
export function exportPath(path: string, query: string): string {
  const params = new URLSearchParams(query);
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}`;
}
