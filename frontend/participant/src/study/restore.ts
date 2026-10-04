import type { MatrixClient } from "matrix-js-sdk";
import type {
  ParticipationOutcomeResponse,
  ProlificIdentity,
  PublicSession,
} from "@gdm/shared";
import { httpSessionManager } from "./sessionClient";
import { startMatrixClient } from "./matrixClient";
import { saveProgress, TOKEN_STORAGE_KEY } from "./progress";
import type { ProgressStage, StudyProgress } from "./progress";

/**
 * The participant journey from the wireframe:
 *   recruiting → survey → waiting → chat → exit (survey) → done
 * with "terminated" for every early, server-recorded or local end.
 */
export type Stage =
  | "recruiting"
  | "survey"
  | "waiting"
  | "chat"
  | "exit"
  | "done"
  | "terminated";

/** Everything the app needs to continue the study at a restored stage. */
export interface RestoredStudy {
  stage: Stage;
  trackingToken?: string;
  session?: PublicSession;
  /** Kept separately so the "done" page works without re-fetching the session. */
  sessionId?: string;
  participantId?: string;
  client?: MatrixClient;
  groupRanking?: string[];
  compensationUrl?: string;
  termination?: ParticipationOutcomeResponse;
}

/**
 * Restore a Prolific seat from the server after the participant closed and
 * reopened the study. The resume endpoint deliberately accepts ended
 * submission statuses so an already-recorded terminal outcome can still show
 * its debrief. Returns null on a genuinely new visit.
 */
export async function restoreProlificSeat(
  prolific: ProlificIdentity,
): Promise<RestoredStudy | null> {
  const resumed = await httpSessionManager.resumeProlific(prolific);
  if (!resumed) return null;
  if (resumed.stage === "terminated" && resumed.termination) {
    return { stage: "terminated", termination: resumed.termination };
  }
  if (!resumed.openSession) {
    throw new Error("The saved Prolific participation could not be resumed");
  }

  const { session, participantId, matrix } = resumed.openSession;
  const restored = { session, sessionId: session.id, participantId };
  const persist = (stage: ProgressStage) =>
    saveProgress({ stage, sessionId: session.id, participantId, matrix });

  switch (resumed.stage) {
    case "waiting":
      persist("waiting");
      return { ...restored, stage: "waiting" };
    case "chat": {
      const client = await startMatrixClient(matrix);
      persist("chat");
      return { ...restored, stage: "chat", client };
    }
    case "exit":
      persist("exit");
      return { ...restored, stage: "exit", groupRanking: session.ranking.order };
    default: {
      const completion = await httpSessionManager.completeParticipant(
        session.id,
        participantId,
      );
      persist("done");
      return {
        ...restored,
        stage: "done",
        compensationUrl: completion.compensationUrl,
      };
    }
  }
}

/**
 * A refresh must not restart the flow: the participant already holds a seat
 * (and their group would wait for a ghost). Waiting resumes via openSession
 * (the backend hands the same seat back for the same tracking token); chat
 * and exit resume from the stored session + Matrix credentials; "done"
 * re-fetches the completion URL from the stored ids.
 */
export async function restoreFromProgress(
  progress: StudyProgress,
  prolific: ProlificIdentity | undefined,
): Promise<RestoredStudy> {
  if (prolific) {
    const outcome = await httpSessionManager.getParticipationOutcome(prolific);
    if (outcome && outcome.outcome !== "completed") {
      return { stage: "terminated", termination: outcome };
    }
  }

  switch (progress.stage) {
    case "done": {
      const restored: RestoredStudy = {
        stage: "done",
        sessionId: progress.sessionId,
        participantId: progress.participantId,
      };
      // Idempotently retrieve the completion URL again after a refresh.
      try {
        const completion = await httpSessionManager.completeParticipant(
          progress.sessionId,
          progress.participantId,
        );
        restored.compensationUrl = completion.compensationUrl;
      } catch {
        /* keep the debriefing fallback */
      }
      return restored;
    }
    case "waiting": {
      // Re-enter the waiting room; WaitingRoom re-runs openSession and the
      // backend hands back the seat this token already holds.
      const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      return token
        ? { stage: "waiting", trackingToken: token }
        : { stage: "recruiting" };
    }
    case "exit": {
      const session = await httpSessionManager.getSession(progress.sessionId);
      return {
        stage: "exit",
        session,
        groupRanking: session.ranking.order,
        participantId: progress.participantId,
      };
    }
    case "chat": {
      const session = await httpSessionManager.getSession(progress.sessionId);
      const client = await startMatrixClient(progress.matrix);
      return {
        stage: "chat",
        session,
        participantId: progress.participantId,
        client,
      };
    }
  }
}
