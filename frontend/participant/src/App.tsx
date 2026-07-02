import { useEffect, useState } from "react";
import Login from "./components/Login";
import Chat from "./components/Chat";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import "./App.css";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8008";

export default function App() {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Check for magic link token or existing session on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (token) {
      loginWithToken(token);
    } else {
      // No token — show dev login (or later: "waiting for link" screen)
      setLoading(false);
    }
  }, []);

  async function loginWithToken(token: string) {
    try {
      setLoading(true);
      setError(null);

      // The token is a Matrix access_token pre-created by the session manager.
      // We use it directly to create an authenticated client.
      const tempClient = createClient({
        baseUrl: HOMESERVER,
        accessToken: token,
      });

      // Verify the token by fetching the user ID
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

      // Clean the token from the URL without reloading
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());

      setClient(matrixClient);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Invalid link";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
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

  // Dev login fallback (no token in URL)
  if (!client) {
    return <Login onLogin={setClient} />;
  }

  return <Chat client={client} />;
}
