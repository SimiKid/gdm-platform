import { useEffect, useState } from "react";
import Recruiting from "./components/Recruiting";
import Survey from "./components/Survey";
import WaitingRoom from "./components/WaitingRoom";
import ExitSurvey from "./components/ExitSurvey";
import Chat from "./components/Chat";
import DebriefingPage from "./components/DebriefingPage";
import StudyExitPage from "./components/StudyExitPage";
import { createClient } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type {
  ParticipationOutcomeResponse,
  ProlificIdentity,
  PublicSession,
  StudyInfoResponse,
  StudyTaskMode,
  Survey as SurveyData,
  TerminateParticipationRequest,
} from "@gdm/shared";
import { httpSessionManager } from "./study/sessionClient";
import { clearProgress, loadProgress, updateStage } from "./study/progress";
import type { StudyProgress } from "./study/progress";
import { loadProlificIdentity } from "./study/prolific";
import { startMatrixClient } from "./study/matrixClient";
import { restoreFromProgress, restoreProlificSeat } from "./study/restore";
import type { RestoredStudy, Stage } from "./study/restore";
import "./App.css";
import { workspaceClient } from "./study/workspaceClient";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8010";

export default function App() {
  const [stage, setStage] = useState<Stage>("recruiting");
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [prolific, setProlific] = useState<ProlificIdentity | undefined>();
  const [conditionId, setConditionId] = useState<string | undefined>();
  const [entrySurvey, setEntrySurvey] = useState<SurveyData | null>(null);
  const [session, setSession] = useState<PublicSession | null>(null);
  // Set when a refresh restores the "done" page, which has no session object.
  const [restoredSessionId, setRestoredSessionId] = useState("");
  const [participantId, setParticipantId] = useState("");
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [groupRanking, setGroupRanking] = useState<string[]>([]);
  const [taskMode, setTaskMode] = useState<StudyTaskMode>("ranking");
  const [studyInfo, setStudyInfo] = useState<StudyInfoResponse | null>(null);
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

  /** Continue the study at a stage restored after a refresh or reopen. */
  function applyRestored(restored: RestoredStudy) {
    if (restored.trackingToken) setTrackingToken(restored.trackingToken);
    if (restored.session) setSession(restored.session);
    if (restored.sessionId) setRestoredSessionId(restored.sessionId);
    if (restored.participantId) setParticipantId(restored.participantId);
    if (restored.client) setClient(restored.client);
    if (restored.groupRanking) setGroupRanking(restored.groupRanking);
    if (restored.compensationUrl !== undefined) {
      setCompensationUrl(restored.compensationUrl);
    }
    if (restored.termination) {
      setError(null);
      setTermination(restored.termination);
    }
    setStage(restored.stage);
  }

  async function enterStudy(
    token: string,
    forcedConditionId?: string,
    prolificIdentity?: ProlificIdentity,
  ) {
    try {
      if (prolificIdentity) {
        setBooting(true);
        // Resume first: a participant may reopen after accepting Prolific's
        // return request. A genuinely new visit is persisted below and
        // continues to use active-submission validation.
        const restored = await restoreProlificSeat(prolificIdentity);
        if (restored) {
          setProlific(prolificIdentity);
          if (restored.stage !== "terminated") {
            setTrackingToken(token);
            setConditionId(forcedConditionId);
          }
          applyRestored(restored);
          return;
        }
        await httpSessionManager.recordProlificArrival(prolificIdentity);
      }
      setTrackingToken(token);
      setConditionId(forcedConditionId);
      setProlific(prolificIdentity);
      // Group size and discussion length for the instructions; the pages use
      // neutral wording until (or unless) this arrives.
      void httpSessionManager
        .getStudyInfo(forcedConditionId)
        .then(setStudyInfo)
        .catch(() => undefined);
      if (prolificIdentity) {
        await httpSessionManager.recordParticipationProgress(
          prolificIdentity,
          "consent",
        );
      }
      const admission = await workspaceClient.prepare(token);
      setTaskMode(admission.mode);
      setStage("survey");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "We could not start your study. Please try again.",
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

  async function resume(progress: StudyProgress) {
    try {
      const storedProlific = loadProlificIdentity();
      setProlific(storedProlific);
      applyRestored(await restoreFromProgress(progress, storedProlific));
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
    outcome: TerminateParticipationRequest["outcome"],
    reason?: string,
  ) {
    if (taskMode === "etherpad" && trackingToken) {
      void workspaceClient.leave(trackingToken).catch(() => undefined);
    }
    if (!prolific) {
      // No Prolific submission to return, so mirror the server's per-outcome
      // wording without its return instructions.
      const message =
        outcome === "ineligible"
          ? "You cannot continue with this study. You may close this page."
          : outcome === "declined_consent"
            ? "You have not entered the study. You may close this page."
            : "Your withdrawal was recorded. You may close this page.";
      setTermination({
        outcome,
        compensationKind: "none",
        redirectUrl: "",
        message,
      });
      // Nothing server-side remembers a direct participant's exit, so drop the
      // saved progress: a refresh must not resume them into the study again.
      clearProgress();
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
        prolific
          ? "Do you want to stop participating? Your progress will be recorded and the researcher will review any compensation due."
          : "Do you want to stop participating?",
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
    return (
      <StudyExitPage
        termination={termination}
        prolificParticipant={Boolean(prolific)}
      />
    );
  }

  // In the chat room: a live Matrix client + the chat stage. (Dev fast-path
  // has no session, so its timer never fires and it stays here.)
  if (client && stage === "chat") {
    return (
      <Chat
        client={client}
        session={session}
        onWithdraw={withdraw}
        onTimeUp={(finalOrder) => {
          client.stopClient();
          setClient(null);
          setGroupRanking(finalOrder);
          if (prolific) {
            void httpSessionManager
              .recordParticipationProgress(prolific, "exit")
              .catch(() => undefined);
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
          taskMode={taskMode}
          studyInfo={studyInfo}
          onDecline={() => void endParticipation("declined_consent")}
          onIneligible={(reason) =>
            void endParticipation("ineligible", reason)
          }
          onWithdraw={withdraw}
          onComplete={(survey) => {
            setEntrySurvey(survey);
            if (prolific) {
              void httpSessionManager
                .recordParticipationProgress(prolific, "entry")
                .catch(() => undefined);
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
          onWithdraw={withdraw}
          onTerminated={(outcome) => {
            setTermination(outcome);
            setStage("terminated");
          }}
          onReady={(readyClient, readySession, readyParticipantId) => {
            setSession(readySession);
            setParticipantId(readyParticipantId);
            setClient(readyClient);
            if (prolific) {
              void httpSessionManager
                .recordParticipationProgress(prolific, "chat")
                .catch(() => undefined);
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
          prolificParticipant={Boolean(prolific)}
          sessionId={session?.id ?? restoredSessionId}
          participantId={participantId}
        />
      );

    default:
      return null;
  }
}
