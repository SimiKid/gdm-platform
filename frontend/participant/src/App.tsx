import { useEffect, useState } from "react";
import Recruiting from "./components/Recruiting";
import Survey from "./components/Survey";
import WaitingRoom from "./components/WaitingRoom";
import ExitSurvey from "./components/ExitSurvey";
import Login from "./components/Login";
import Chat from "./components/Chat";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { Session, Survey as SurveyData } from "@gdm/shared";
import "./App.css";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8008";

/**
 * The participant journey from the wireframe:
 *   recruiting → survey → waiting → chat → (exit survey)
 * `devlogin` is the developer fast-path (username/password), separate from the
 * real study flow which is driven by the individual tracking link.
 */
type Stage =
  | "recruiting"
  | "survey"
  | "waiting"
  | "chat"
  | "exit"
  | "done"
  | "devlogin";

export default function App() {
  const [stage, setStage] = useState<Stage>("recruiting");
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [entrySurvey, setEntrySurvey] = useState<SurveyData | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [participantId, setParticipantId] = useState("");
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  // Dev fast-path: ?token=<matrix access token> jumps straight into chat,
  // bypassing the study flow. Handy for testing the chat room in isolation.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    if (token) {
      loginWithToken(token);
    } else {
      setBooting(false);
    }
  }, []);

  async function loginWithToken(token: string) {
    try {
      setBooting(true);
      setError(null);

      const tempClient = createClient({ baseUrl: HOMESERVER, accessToken: token });
      const whoami = await tempClient.whoami();

      const matrixClient = createClient({
        baseUrl: HOMESERVER,
        accessToken: token,
        userId: whoami.user_id,
      });

      await matrixClient.startClient({ initialSyncLimit: 20 });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Sync timed out")),
          15000,
        );
        matrixClient.once(ClientEvent.Sync, (state: string) => {
          clearTimeout(timeout);
          if (state === "PREPARED") resolve();
          else reject(new Error(`Sync failed: ${state}`));
        });
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
        onTimeUp={() => setStage("exit")}
      />
    );
  }

  switch (stage) {
    case "recruiting":
      return (
        <Recruiting
          onEnter={(t) => {
            setTrackingToken(t);
            setStage("survey");
          }}
          onDevLogin={() => setStage("devlogin")}
        />
      );

    case "devlogin":
      return <Login onLogin={setClient} />;

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
          entrySurvey={entrySurvey}
          onReady={(readyClient, readySession, readyParticipantId) => {
            setSession(readySession);
            setParticipantId(readyParticipantId);
            setClient(readyClient);
            setStage("chat");
          }}
        />
      );

    case "exit":
      if (!session || !client) return null;
      return (
        <ExitSurvey
          client={client}
          session={session}
          participantId={participantId}
          onDone={() => setStage("done")}
        />
      );

    case "done":
      return (
        <div className="login-container">
          <h1>Thank you!</h1>
          <p className="login-hint">
            Your responses have been recorded.
          </p>
          <a
            className="pay-button"
            href={import.meta.env.VITE_PAYMENT_URL ?? "#"}
          >
            Get paid
          </a>
        </div>
      );

    default:
      return null;
  }
}
