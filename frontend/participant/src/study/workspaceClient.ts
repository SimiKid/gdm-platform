import type { PadPhase, StudyAdmission, StudyPad } from "@gdm/shared";
import { API_BASE } from "./api";

const REQUEST_TIMEOUT_MS = 20_000;

/** Error body the Session Manager sends for a rejected workspace request. */
interface WorkspaceErrorBody {
  message?: string;
  code?: string;
}

/** A failed workspace request; `code` lets callers react to known states. */
export type WorkspaceError = Error & { code?: string };

async function request<T>(
  path: string,
  token: string,
  body: object = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}/workspace/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const error = (await response
      .json()
      .catch(() => ({}))) as WorkspaceErrorBody;
    const failure: WorkspaceError = new Error(
      error.message || "The writing workspace is unavailable. Please retry.",
    );
    failure.code = error.code;
    throw failure;
  }
  return (await response.json()) as T;
}

/** Client for the Etherpad writing workspace endpoints of the Session Manager. */
export const workspaceClient = {
  prepare: (token: string) => request<StudyAdmission>("prepare", token),
  pad: (token: string, phase: PadPhase, sessionId?: string) =>
    request<StudyPad>(`pads/${phase}`, token, { sessionId }),
  finish: (token: string, id: string) =>
    request<StudyPad>(`finish/${id}`, token),
  leave: (token: string) => request<{ ok: boolean }>("leave", token),
};
