import { type FormEvent, useState } from "react";
import { createClient, ClientEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";

const HOMESERVER =
  import.meta.env.VITE_MATRIX_HOMESERVER ?? "http://localhost:8008";

interface Props {
  onLogin: (client: MatrixClient) => void;
}

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const tempClient = createClient({ baseUrl: HOMESERVER });

      if (isRegister) {
        await tempClient.registerRequest({
          username,
          password,
          auth: { type: "m.login.dummy" },
        });
      }

      const loginResponse = await tempClient.login("m.login.password", {
        user: username,
        password,
      });

      const client = createClient({
        baseUrl: HOMESERVER,
        accessToken: loginResponse.access_token,
        userId: loginResponse.user_id,
      });

      await client.startClient({ initialSyncLimit: 20 });

      await new Promise<void>((resolve) => {
        client.once(ClientEvent.Sync, (state: string) => {
          if (state === "PREPARED") resolve();
        });
      });

      onLogin(client);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-container">
      <h1>GDM Study Platform</h1>
      <p className="login-hint">
        Developer login — participants join via study link
      </p>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          autoFocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" disabled={loading}>
          {loading ? "..." : isRegister ? "Register" : "Login"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
      <button
        type="button"
        className="toggle"
        onClick={() => setIsRegister(!isRegister)}
      >
        {isRegister ? "Already have an account? Login" : "No account? Register"}
      </button>
    </div>
  );
}
