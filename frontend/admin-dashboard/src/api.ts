/**
 * Session Manager access for the dashboard. All researcher endpoints are
 * protected by ADMIN_API_TOKEN on the backend; the token is entered once in
 * the dashboard and kept on this browser until it is replaced or cleared.
 * When the backend runs without a token (local dev), everything works without
 * entering one.
 */

import type { Condition } from "@gdm/shared";

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
  return fetch(apiUrl(path), {
    ...init,
    headers,
  });
}

/** Session Manager URL for an API path (shared by fetches and download hrefs). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** PUT one condition (recruiting switch, goal, shared parameters). */
export async function putCondition(condition: Condition): Promise<Condition> {
  const res = await apiFetch(`/conditions/${condition.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ condition }),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  return (await res.json()) as Condition;
}
