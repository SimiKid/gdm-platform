import { useEffect, useRef, useState } from "react";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { ProlificIdentity, PublicSession, Survey } from "@gdm/shared";
import { httpSessionManager } from "../study/sessionClient";
import { saveProgress } from "../study/progress";
import StudyShell from "./StudyShell";

interface Props {
  trackingToken: string;
  prolific?: ProlificIdentity;
  conditionId?: string;
  entrySurvey: Survey | null;
  /** Called with a synced Matrix client, the session, and our participant id. */
  onReady: (
    client: MatrixClient,
    session: PublicSession,
    participantId: string,
  ) => void;
  onTerminated?: (outcome: import("@gdm/shared").ParticipationOutcomeResponse) => void;
  onWithdraw?: () => void;
}

/**
 * Waiting Room (wireframe: "n people").
 *
 * Calls openSession to join a forming group, persists the entry survey, boots
 * a real Matrix client against local Synapse, and polls the session until the
 * Session Manager provisions the room (i.e. the group is full). Then it hands
 * the live client up to the chat room.
 *
 * openSession is idempotent per tracking token (the backend returns the seat
 * the token already holds), so re-running after an error or refresh is safe.
 */
export default function WaitingRoom({
  trackingToken,
  prolific,
  conditionId,
  entrySurvey,
  onReady,
  onTerminated,
  onWithdraw,
}: Props) {
  const [count, setCount] = useState(0);
  const [groupSize, setGroupSize] = useState(0);
  const [deadlineAt, setDeadlineAt] = useState<string | undefined>();
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the idempotent join flow after a transient error.
  const [attempt, setAttempt] = useState(0);

  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Keep the latest onReady without making it an effect dependency.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onTerminatedRef = useRef(onTerminated);
  onTerminatedRef.current = onTerminated;

  useEffect(() => {
    let cancelled = false;
    let handedOff = false;
    let matrixClient: MatrixClient | undefined;

    async function run() {
      try {
        const res = await httpSessionManager.openSession({
          trackingToken,
          participantName: "",
          prolific,
          conditionId,
        });
        if (cancelled) return;

        setCount(res.session.participants.length);
        setGroupSize(res.session.condition.groupSize);
        setDeadlineAt(res.session.waitingDeadlineAt);

        // Survive a refresh: with the seat and credentials stored, F5 lands
        // back here (or straight in the chat) instead of at recruiting.
        saveProgress({
          stage: "waiting",
          sessionId: res.session.id,
          participantId: res.participantId,
          matrix: res.matrix,
        });

        if (entrySurvey) {
          await httpSessionManager.submitSurvey({
            sessionId: res.session.id,
            participantId: res.participantId,
            kind: "entry",
            survey: entrySurvey,
          });
        }

        const client = createClient({
          baseUrl: res.matrix.homeserverUrl,
          accessToken: res.matrix.accessToken,
          userId: res.matrix.userId,
        });
        matrixClient = client;
        await client.startClient({ initialSyncLimit: 20 });
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Could not connect to the chat server")),
            15000,
          );
          client.once(ClientEvent.Sync, (state: string) => {
            clearTimeout(timeout);
            if (state === "PREPARED") resolve();
            else reject(new Error(`Chat connection failed (${state})`));
          });
        });
        if (cancelled) {
          client.stopClient();
          return;
        }

        const ready = (session: PublicSession) => {
          if (cancelled || handedOff) return;
          handedOff = true;
          saveProgress({
            stage: "chat",
            sessionId: session.id,
            participantId: res.participantId,
            matrix: { ...res.matrix, roomId: session.roomId ?? "" },
          });
          onReadyRef.current(client, session, res.participantId);
        };

        // If our own join already completed the group, go straight in.
        if (res.matrix.roomId) {
          ready(res.session);
          return;
        }

        // Otherwise poll until the Session Manager provisions the room.
        const poll = async () => {
          try {
            const session = await httpSessionManager.getSession(res.session.id);
            if (cancelled || handedOff) return;
            if (session.status === "aborted") {
              if (prolific) {
                const outcome = await httpSessionManager.getParticipationOutcome(prolific);
                if (outcome) {
                  clearTimeout(pollRef.current);
                  client.stopClient();
                  if (onTerminatedRef.current) onTerminatedRef.current(outcome);
                  else setError(outcome.message);
                  return;
                }
                // The durable session abort and its participant outcomes are
                // committed in sequence. Retry briefly if polling lands in
                // that small window instead of showing a false hard failure.
              } else {
                clearTimeout(pollRef.current);
                client.stopClient();
                setError("This waiting session ended before a complete group formed.");
                return;
              }
            }
            setCount(session.participants.length);
            setGroupSize(session.condition.groupSize);
            setDeadlineAt(session.waitingDeadlineAt);
            if (session.roomId) {
              clearTimeout(pollRef.current);
              ready(session);
              return;
            }
          } catch {
            /* transient — keep polling */
          }
          if (!cancelled && !handedOff) {
            pollRef.current = setTimeout(() => void poll(), 2000);
          }
        };
        pollRef.current = setTimeout(() => void poll(), 2000);
      } catch (err: unknown) {
        matrixClient?.stopClient();
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not join a session");
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      if (!handedOff) matrixClient?.stopClient();
    };
  }, [attempt, trackingToken, prolific, conditionId, entrySurvey]);

  useEffect(() => {
    if (!deadlineAt) {
      setSecondsRemaining(null);
      return;
    }
    const tick = () =>
      setSecondsRemaining(
        Math.max(0, Math.ceil((Date.parse(deadlineAt) - Date.now()) / 1_000)),
      );
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [deadlineAt]);

  if (error) {
    return (
      <StudyShell step={4} onWithdraw={onWithdraw}>
        <div className="study-card narrow centered">
          <h1>Waiting room</h1>
          <p className="error">{error}</p>
          <p>The study may be full, or the servers aren't running.</p>
          <div className="card-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setError(null);
                setAttempt((a) => a + 1);
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </StudyShell>
    );
  }

  return (
    <StudyShell step={4} onWithdraw={onWithdraw}>
      <div className="study-card narrow centered">
        <h1>Waiting room</h1>
        <div className="waiting-spinner" aria-hidden="true" />
        <p>Thanks! We're waiting for the group to fill up...</p>
        <p className="waiting-count" aria-live="polite">
          {count}
          {groupSize ? ` / ${groupSize}` : ""} people joined
        </p>
        {secondsRemaining !== null && (
          <p className="action-hint" role="timer">
            If a complete group cannot be formed, waiting ends in {Math.floor(secondsRemaining / 60)}:
            {(secondsRemaining % 60).toString().padStart(2, "0")} and partial compensation is reviewed.
          </p>
        )}
      </div>
    </StudyShell>
  );
}
