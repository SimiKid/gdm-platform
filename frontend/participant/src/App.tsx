import { useEffect, useState } from "react";
import Recruiting from "./components/Recruiting";
import Survey from "./components/Survey";
import WaitingRoom from "./components/WaitingRoom";
import ExitSurvey from "./components/ExitSurvey";
import Chat from "./components/Chat";
import DebriefingPage from "./components/DebriefingPage";
import StudyExitPage from "./components/StudyExitPage";
import { createClient, ClientEvent, EventTimeline } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type {
  ParticipationOutcomeResponse,
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
import { loadProlificIdentity } from "./study/prolific";
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
  | "done"
  | "terminated";

/** Start a Matrix client from stored credentials and wait for the first sync.
 *  After sync, backfill the room timeline so reloads never lose messages. */
async function startMatrixClient(matrix: {
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  roomId?: string;
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

  // Study rooms are small — backfill the full timeline so a page reload never
  // drops earlier messages that fell outside the initialSyncLimit window.
  if (matrix.roomId) {
    const room = client.getRoom(matrix.roomId);
    if (room) {
      const timeline = room.getLiveTimeline();
      while (timeline.getPaginationToken(EventTimeline.BACKWARDS)) {
        await client.paginateEventTimeline(timeline, {
          backwards: true,
          limit: 100,
        });
      }
    }
  }

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
  const [termination, setTermination] =
    useState<ParticipationOutcomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // Matrix sync loops are long-lived; stop the previous client whenever the
  // study changes stage or this application unmounts.
  useEffect(
    () => () => {
      client?.stopClient();
    },
    [client],
  );

  useEffect(() => {
    if (!prolific) return;
    const milestones: Partial<
      Record<Stage, "consent" | "waiting" | "chat" | "exit">
    > = {
      survey: "consent",
      waiting: "waiting",
      chat: "chat",
      exit: "exit",
    };
    const milestone = milestones[stage];
    if (!milestone) return;
    const heartbeat = async () => {
      await httpSessionManager.recordParticipationProgress(prolific, milestone);
      const outcome = await httpSessionManager.getParticipationOutcome(prolific);
      if (outcome && outcome.outcome !== "completed") {
        client?.stopClient();
        setClient(null);
        setError(null);
        setTermination(outcome);
        setStage("terminated");
      }
    };
    void heartbeat().catch(() => undefined);
    const timer = setInterval(
      () => void heartbeat().catch(() => undefined),
      10_000,
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void heartbeat().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, prolific, stage]);

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
          if (resumed.stage === "terminated" && resumed.termination) {
            setProlific(prolificIdentity);
            setTermination(resumed.termination);
            setStage("terminated");
            return;
          }
          if (!resumed.openSession) {
            throw new Error("The saved Prolific participation could not be resumed");
          }
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
      if (prolificIdentity) {
        await httpSessionManager.recordParticipationProgress(
          prolificIdentity,
          "consent",
        );
      }
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
      const storedProlific = loadProlificIdentity();
      setProlific(storedProlific);
      if (storedProlific) {
        const outcome =
          await httpSessionManager.getParticipationOutcome(storedProlific);
        if (outcome && outcome.outcome !== "completed") {
          setError(null);
          setTermination(outcome);
          setStage("terminated");
          return;
        }
      }
      switch (progress.stage) {
        case "done":
          setParticipantId(progress.participantId);
          // Idempotently retrieve the completion URL again after a refresh.
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

  async function endParticipation(
    outcome: "declined_consent" | "ineligible" | "voluntary_withdrawal",
    reason?: string,
  ) {
    if (!prolific) {
      setTermination({
        outcome,
        compensationKind: "none",
        redirectUrl: "",
        message: "Your withdrawal was recorded. You may close this page.",
      });
      client?.stopClient();
      setClient(null);
      setStage("terminated");
      return;
    }
    try {
      setBooting(true);
      const result = await httpSessionManager.terminateParticipation(
        prolific,
        outcome,
        reason,
      );
      client?.stopClient();
      setClient(null);
      setError(null);
      setTermination(result);
      setStage("terminated");
    } catch {
      setError(
        "We could not record that you are leaving. Please keep this page open and contact the researcher through Prolific.",
      );
    } finally {
      setBooting(false);
    }
  }

  function withdraw() {
    if (
      window.confirm(
        "Do you want to stop participating? Your progress will be recorded and the researcher will review any compensation due.",
      )
    ) {
      void endParticipation("voluntary_withdrawal");
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

  if (stage === "terminated" && termination) {
    return <StudyExitPage termination={termination} />;
  }

  // In the chat room: a live Matrix client + the chat stage. (Dev fast-path
  // has no session, so its timer never fires and it stays here.)
  if (client && stage === "chat") {
    return (
      <Chat
        client={client}
        session={session}
        onWithdraw={prolific ? withdraw : undefined}
        onTimeUp={(finalOrder) => {
          client.stopClient();
          setClient(null);
          setGroupRanking(finalOrder);
          if (prolific) {
            void httpSessionManager.recordParticipationProgress(prolific, "exit");
          }
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
          onDecline={() => void endParticipation("declined_consent")}
          onIneligible={(reason) =>
            void endParticipation("ineligible", reason)
          }
          onWithdraw={withdraw}
          onComplete={(survey) => {
            setEntrySurvey(survey);
            if (prolific) {
              void httpSessionManager.recordParticipationProgress(prolific, "entry");
            }
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
          onWithdraw={prolific ? withdraw : undefined}
          onTerminated={(outcome) => {
            setTermination(outcome);
            setStage("terminated");
          }}
          onReady={(readyClient, readySession, readyParticipantId) => {
            setSession(readySession);
            setParticipantId(readyParticipantId);
            setClient(readyClient);
            if (prolific) {
              void httpSessionManager.recordParticipationProgress(prolific, "chat");
            }
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
          onWithdraw={withdraw}
          onDone={(completion) => {
            setCompensationUrl(completion.compensationUrl);
            updateStage("done");
            setStage("done");
          }}
        />
      );

    case "done":
      return (
        <DebriefingPage
          completionUrl={compensationUrl}
          sessionId={session?.id ?? ""}
          participantId={participantId}
        />
      );

    default:
      return null;
  }
}
