import { useEffect, useState } from "react";
import Recruiting from "./components/Recruiting";
import Survey from "./components/Survey";
import WaitingRoom from "./components/WaitingRoom";
import ExitSurvey from "./components/ExitSurvey";
import Chat from "./components/Chat";
import DebriefingPage from "./components/DebriefingPage";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type {
  ProlificIdentity,
  PublicSession,
  Survey as SurveyData,
} from "@gdm/shared";
import { httpSessionManager } from "./study/sessionClient";
import {
  loadProgress,
  saveProgress,
  updateStage,
  TOKEN_STORAGE_KEY,
} from "./study/progress";
import type { StudyProgress } from "./study/progress";
import "./App.css";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8008";

/**
 * The participant journey from the wireframe:
 *   recruiting → survey → waiting → chat → (exit survey)
 */
type Stage =
  | "recruiting"
  | "survey"
  | "waiting"
  | "chat"
  | "exit"
  | "done";

/** Start a Matrix client from stored credentials and wait for the first sync. */
async function startMatrixClient(matrix: {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
}): Promise<MatrixClient> {
  const client = createClient({
    baseUrl: matrix.homeserverUrl,
    accessToken: matrix.accessToken,
    userId: matrix.userId,
  });
  await client.startClient({ initialSyncLimit: 20 });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Sync timed out")), 15000);
    client.once(ClientEvent.Sync, (state: string) => {
      clearTimeout(timeout);
      if (state === "PREPARED") resolve();
      else reject(new Error(`Sync failed: ${state}`));
    });
  });
  return client;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("recruiting");
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [prolific, setProlific] = useState<ProlificIdentity | undefined>();
  const [conditionId, setConditionId] = useState<string | undefined>();
  const [entrySurvey, setEntrySurvey] = useState<SurveyData | null>(null);
  const [session, setSession] = useState<PublicSession | null>(null);
  const [participantId, setParticipantId] = useState("");
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [groupRanking, setGroupRanking] = useState<string[]>([]);
  const [compensationUrl, setCompensationUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  async function enterStudy(
    token: string,
    forcedConditionId?: string,
    prolificIdentity?: ProlificIdentity,
  ) {
    try {
      if (prolificIdentity) {
        setBooting(true);
        await httpSessionManager.recordProlificArrival(prolificIdentity);
        const resumed =
          await httpSessionManager.resumeProlific(prolificIdentity);
        if (resumed) {
          const { openSession, stage: resumedStage } = resumed;
          const {
            session: resumedSession,
            participantId: resumedParticipantId,
            matrix,
          } = openSession;
          setTrackingToken(token);
          setConditionId(forcedConditionId);
          setProlific(prolificIdentity);
          setSession(resumedSession);
          setParticipantId(resumedParticipantId);

          if (resumedStage === "waiting") {
            saveProgress({
              stage: "waiting",
              sessionId: resumedSession.id,
              participantId: resumedParticipantId,
              matrix,
            });
            setStage("waiting");
          } else if (resumedStage === "chat") {
            const matrixClient = await startMatrixClient(matrix);
            saveProgress({
              stage: "chat",
              sessionId: resumedSession.id,
              participantId: resumedParticipantId,
              matrix,
            });
            setClient(matrixClient);
            setStage("chat");
          } else if (resumedStage === "exit") {
            setGroupRanking(resumedSession.ranking.order);
            saveProgress({
              stage: "exit",
              sessionId: resumedSession.id,
              participantId: resumedParticipantId,
              matrix,
            });
            setStage("exit");
          } else {
            const completion = await httpSessionManager.completeParticipant(
              resumedSession.id,
              resumedParticipantId,
            );
            setCompensationUrl(completion.compensationUrl);
            saveProgress({
              stage: "done",
              sessionId: resumedSession.id,
              participantId: resumedParticipantId,
              matrix,
            });
            setStage("done");
          }
          return;
        }
      }
      setTrackingToken(token);
      setConditionId(forcedConditionId);
      setProlific(prolificIdentity);
      setStage("survey");
    } catch {
      setError(
        "We could not validate your Prolific study link. Please return to Prolific and try again.",
      );
    } finally {
      setBooting(false);
    }
  }

  // Boot order: dev fast-path (?token=), then resume a refreshed study tab
  // from persisted progress, else start fresh at recruiting.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      void loginWithToken(token);
      return;
    }
    const progress = loadProgress();
    if (progress) {
      void resume(progress);
      return;
    }
    setBooting(false);
  }, []);

  /**
   * A refresh must not restart the flow: the participant already holds a seat
   * (and their group would wait for a ghost). Waiting resumes via openSession
   * (the backend hands the same seat back for the same tracking token); chat
   * and exit resume from the stored session + Matrix credentials.
   */
  async function resume(progress: StudyProgress) {
    try {
      switch (progress.stage) {
        case "done":
          setParticipantId(progress.participantId);
          // Idempotently retrieve the completion URL again after a refresh.
          // Legacy/generic sessions fall back to the public study setting.
          try {
            const completion = await httpSessionManager.completeParticipant(
              progress.sessionId,
              progress.participantId,
            );
            setCompensationUrl(completion.compensationUrl);
          } catch {
            /* keep the debriefing fallback */
          }
          setStage("done");
          break;
        case "waiting": {
          // Re-enter the waiting room; WaitingRoom re-runs openSession and
          // the backend hands back the seat this token already holds.
          const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
          if (token) {
            setTrackingToken(token);
            setStage("waiting");
          } else {
            setStage("recruiting");
          }
          break;
        }
        case "exit": {
          const refreshed = await httpSessionManager.getSession(progress.sessionId);
          setSession(refreshed);
          setGroupRanking(refreshed.ranking.order);
          setParticipantId(progress.participantId);
          setStage("exit");
          break;
        }
        case "chat": {
          const refreshed = await httpSessionManager.getSession(progress.sessionId);
          const matrixClient = await startMatrixClient(progress.matrix);
          setSession(refreshed);
          setParticipantId(progress.participantId);
          setClient(matrixClient);
          setStage("chat");
          break;
        }
      }
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Could not resume your session: ${err.message}`
          : "Could not resume your session",
      );
    } finally {
      setBooting(false);
    }
  }

  // Dev fast-path: ?token=<matrix access token> jumps straight into chat,
  // bypassing the study flow. Handy for testing the chat room in isolation.
  async function loginWithToken(token: string) {
    try {
      setBooting(true);
      setError(null);

      const tempClient = createClient({ baseUrl: HOMESERVER, accessToken: token });
      const whoami = await tempClient.whoami();
      const matrixClient = await startMatrixClient({
        homeserverUrl: HOMESERVER,
        accessToken: token,
        userId: whoami.user_id,
      });

      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());

      setClient(matrixClient);
      setStage("chat");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invalid link";
      setError(msg);
    } finally {
      setBooting(false);
    }
  }

  if (booting) {
    return (
      <div className="loading-container">
        <p>Joining study session...</p>
      </div>
    );
  }

  if (error && !client) {
    return (
      <div className="loading-container">
        <p className="error">{error}</p>
        <p>Please check your study link or contact the researcher.</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    );
  }

  // In the chat room: a live Matrix client + the chat stage. (Dev fast-path
  // has no session, so its timer never fires and it stays here.)
  if (client && stage === "chat") {
    return (
      <Chat
        client={client}
        session={session}
        onTimeUp={(finalOrder) => {
          setGroupRanking(finalOrder);
          updateStage("exit");
          setStage("exit");
        }}
      />
    );
  }

  switch (stage) {
    case "recruiting":
      return (
        <Recruiting
          onEnter={(t, forcedConditionId, prolificIdentity) =>
            void enterStudy(t, forcedConditionId, prolificIdentity)
          }
        />
      );

    case "survey":
      return (
        <Survey
          onComplete={(survey) => {
            setEntrySurvey(survey);
            setStage("waiting");
          }}
        />
      );

    case "waiting":
      if (!trackingToken) return null; // unreachable in the normal flow
      return (
        <WaitingRoom
          trackingToken={trackingToken}
          prolific={prolific}
          conditionId={conditionId}
          entrySurvey={entrySurvey}
          onReady={(readyClient, readySession, readyParticipantId) => {
            setSession(readySession);
            setParticipantId(readyParticipantId);
            setClient(readyClient);
            updateStage("chat");
            setStage("chat");
          }}
        />
      );

    case "exit":
      if (!session) return null;
      return (
        <ExitSurvey
          session={session}
          participantId={participantId}
          groupRanking={groupRanking}
          onDone={(completion) => {
            setCompensationUrl(completion.compensationUrl);
            updateStage("done");
            setStage("done");
          }}
        />
      );

    case "done":
      return <DebriefingPage completionUrl={compensationUrl} />;

    default:
      return null;
  }
}
