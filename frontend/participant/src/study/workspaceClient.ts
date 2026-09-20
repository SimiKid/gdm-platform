import type { PadPhase, StudyAdmission, StudyPad } from "@gdm/shared";
const base = import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
async function request<T>(path: string, token: string, body = {}): Promise<T> {
  const response = await fetch(`${base}/workspace/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || "The writing workspace is unavailable. Please retry.");
  }
  return response.json();
}
export const workspaceClient = {
  prepare: (token: string) => request<StudyAdmission>("prepare", token),
  pad: (token: string, phase: PadPhase, sessionId?: string) => request<StudyPad>(`pads/${phase}`, token, { sessionId }),
  finish: (token: string, id: string) => request<StudyPad>(`finish/${id}`, token),
  leave: (token: string) => request<{ ok: boolean }>("leave", token),
};
