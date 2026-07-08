/**
 * Per-tab persistence of how far the participant got in the study flow, so a
 * browser refresh resumes where they were instead of restarting at recruiting
 * (which would strand their seat and poison the group). sessionStorage keeps
 * it scoped to the tab, like the tracking token.
 */

/** Stages worth resuming. Consent/survey restart from scratch on refresh. */
export type ProgressStage = "waiting" | "chat" | "exit" | "done";

export interface StudyProgress {
  stage: ProgressStage;
  sessionId: string;
  participantId: string;
  matrix: {
    homeserverUrl: string;
    userId: string;
    accessToken: string;
    roomId: string;
  };
}

const KEY = "gdm-study-progress";

/** Per-tab storage key for the participant's tracking token (see Recruiting). */
export const TOKEN_STORAGE_KEY = "gdm-tracking-token";

export function loadProgress(): StudyProgress | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StudyProgress;
    if (!parsed.stage || !parsed.sessionId || !parsed.participantId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveProgress(progress: StudyProgress): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    /* storage unavailable — refresh resume simply won't work */
  }
}

export function updateStage(stage: ProgressStage): void {
  const current = loadProgress();
  if (current) saveProgress({ ...current, stage });
}

export function clearProgress(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
