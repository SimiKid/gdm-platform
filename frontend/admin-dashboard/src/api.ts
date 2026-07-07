/**
 * Session Manager access for the dashboard. All researcher endpoints are
 * protected by ADMIN_API_TOKEN on the backend; the token is entered once in
 * the dashboard and kept in localStorage. When the backend runs without a
 * token (local dev), everything works without entering one.
 */

export const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
export const PARTICIPANT_BASE =
  import.meta.env.VITE_PARTICIPANT_URL ?? "http://localhost:3000";

const TOKEN_KEY = "gdm-admin-token";

export function getAdminToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** fetch against the Session Manager with the admin token attached. */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAdminToken();
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { "x-admin-token": token } : {}),
    },
  });
}

/**
 * Download links can't carry headers, so exports accept the token as a query
 * parameter instead.
 */
export function exportUrl(path: string, query: string): string {
  const token = getAdminToken();
  const params = new URLSearchParams(query);
  if (token) params.set("token", token);
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}
