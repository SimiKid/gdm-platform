import type { ProlificIdentity } from "@gdm/shared";

export const PROLIFIC_STORAGE_KEY = "gdm-prolific-identity";

const PARAMS = {
  participantId: "PROLIFIC_PID",
  studyId: "STUDY_ID",
  sessionId: "SESSION_ID",
} as const;

export interface ParsedProlificIdentity {
  identity?: ProlificIdentity;
  /** At least one Prolific parameter was present, but the set was incomplete. */
  incomplete: boolean;
}

/** Read the standard URL parameters that Prolific appends to an external study. */
export function parseProlificIdentity(
  params: URLSearchParams,
): ParsedProlificIdentity {
  const participantId = params.get(PARAMS.participantId)?.trim() ?? "";
  const studyId = params.get(PARAMS.studyId)?.trim() ?? "";
  const sessionId = params.get(PARAMS.sessionId)?.trim() ?? "";
  const count = [participantId, studyId, sessionId].filter(Boolean).length;

  if (count === 0) return { incomplete: false };
  if (count !== 3) return { incomplete: true };
  return {
    incomplete: false,
    identity: { participantId, studyId, sessionId },
  };
}

/** Stable internal token; does not expose the participant PID in exports/logs. */
export function prolificTrackingToken(identity: ProlificIdentity): string {
  return `prolific:${identity.studyId}:${identity.sessionId}`;
}

export function storeProlificIdentity(identity: ProlificIdentity): void {
  try {
    sessionStorage.setItem(PROLIFIC_STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* storage unavailable — the in-memory identity still works for this page */
  }
}

export function loadProlificIdentity(): ProlificIdentity | undefined {
  try {
    const raw = sessionStorage.getItem(PROLIFIC_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ProlificIdentity>;
    if (!parsed.participantId || !parsed.studyId || !parsed.sessionId) {
      return undefined;
    }
    return parsed as ProlificIdentity;
  } catch {
    return undefined;
  }
}

/** Remove pseudonymous identifiers from the visible URL after capturing them. */
export function stripProlificParameters(url: URL): void {
  Object.values(PARAMS).forEach((name) => url.searchParams.delete(name));
}
