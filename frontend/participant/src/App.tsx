import { useEffect, useState } from "react";
import Recruiting from "./components/Recruiting";
import Survey from "./components/Survey";
import WaitingRoom from "./components/WaitingRoom";
import Login from "./components/Login";
import Chat from "./components/Chat";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import type { Survey as SurveyData } from "@gdm/shared";
import "./App.css";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8008";

/**
 * The participant journey from the wireframe:
 *   recruiting → survey → waiting → chat → (exit survey)
 * `devlogin` is the developer fast-path (username/password), separate from the
 * real study flow which is driven by the individual tracking link.
 */
type Stage = "recruiting" | "survey" | "waiting" | "chat" | "devlogin";

export default function App() {
  const [stage, setStage] = useState<Stage>("recruiting");
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [participantName, setParticipantName] = useState("");
  const [entrySurvey, setEntrySurvey] = useState<SurveyData | null>(null);
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

  // A live Matrix client means we're in the chat room (dev fast-path or,
  // later, provisioned by the Waiting Room via openSession).
  if (client) {
    return <Chat client={client} />;
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
          onComplete={(name, survey) => {
            setParticipantName(name);
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
          participantName={participantName}
          entrySurvey={entrySurvey}
          onReady={(readyClient) => {
            setClient(readyClient);
            setStage("chat");
          }}
        />
      );

    default:
      return null;
  }
}
