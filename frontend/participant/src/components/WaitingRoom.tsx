import { useEffect, useRef, useState } from "react";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { Session, Survey } from "@gdm/shared";
import { httpSessionManager } from "../study/sessionClient";
import StudyShell from "./StudyShell";

interface Props {
  trackingToken: string;
  conditionId?: string;
  entrySurvey: Survey | null;
  /** Called with a synced Matrix client, the session, and our participant id. */
  onReady: (
    client: MatrixClient,
    session: Session,
    participantId: string,
  ) => void;
}

/**
 * Waiting Room (wireframe: "n people").
 *
 * Calls openSession to join a forming group, persists the entry survey, boots
 * a real Matrix client against local Synapse, and polls the session until the
 * Session Manager provisions the room (i.e. the group is full). Then it hands
 * the live client up to the chat room.
 */
export default function WaitingRoom({
  trackingToken,
  conditionId,
  entrySurvey,
  onReady,
}: Props) {
  const [count, setCount] = useState(0);
  const [groupSize, setGroupSize] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Run the join flow exactly once, even under StrictMode's double-invoke.
  const didRun = useRef(false);
  // `alive` is reset to true on (re)mount and set false only on real unmount,
  // so the single in-flight run survives StrictMode's mount→cleanup→mount.
  const alive = useRef(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // Keep the latest onReady without making it an effect dependency.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    alive.current = true;
    if (didRun.current) return;
    didRun.current = true;

    async function run() {
      try {
        const res = await httpSessionManager.openSession({
          trackingToken,
          participantName: "",
          conditionId,
        });
        if (!alive.current) return;

        setCount(res.session.participants.length);
        setGroupSize(res.session.condition.groupSize);

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
        await client.startClient({ initialSyncLimit: 20 });
        await new Promise<void>((resolve) => {
          client.once(ClientEvent.Sync, (state: string) => {
            if (state === "PREPARED") resolve();
          });
        });
        if (!alive.current) return;

        // If our own join already completed the group, go straight in.
        if (res.matrix.roomId) {
          onReadyRef.current(client, res.session, res.participantId);
          return;
        }

        // Otherwise poll until the Session Manager provisions the room.
        pollRef.current = setInterval(async () => {
          try {
            const session = await httpSessionManager.getSession(res.session.id);
            if (!alive.current) return;
            setCount(session.participants.length);
            setGroupSize(session.condition.groupSize);
            if (session.roomId) {
              clearInterval(pollRef.current);
              onReadyRef.current(client, session, res.participantId);
            }
          } catch {
            /* transient — keep polling */
          }
        }, 2000);
      } catch (err: unknown) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : "Could not join a session");
      }
    }

    void run();
    return () => {
      alive.current = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [trackingToken, conditionId, entrySurvey]);

  if (error) {
    return (
      <StudyShell step={4}>
        <div className="study-card narrow centered">
          <h1>Waiting room</h1>
          <p className="error">{error}</p>
          <p>The study may be full, or the servers aren't running.</p>
        </div>
      </StudyShell>
    );
  }

  return (
    <StudyShell step={4}>
      <div className="study-card narrow centered">
        <h1>Waiting room</h1>
        <div className="waiting-spinner" aria-hidden="true" />
        <p>Thanks — waiting for the group to fill up...</p>
        <p className="waiting-count" aria-live="polite">
          {count}
          {groupSize ? ` / ${groupSize}` : ""} people joined
        </p>
      </div>
    </StudyShell>
  );
}
