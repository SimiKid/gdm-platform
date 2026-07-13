import { useCallback, useEffect, useState } from "react";
import type { ConditionProgress, SessionSummary } from "@gdm/shared";
import Overview from "./components/Overview";
import Settings from "./components/Settings";
import { apiFetch, getAdminToken, setAdminToken } from "./api";

export { API_BASE, PARTICIPANT_BASE } from "./api";

/** How often the dashboard refreshes itself (drives the "Live" indicator). */
const POLL_MS = 5000;

type View = "overview" | "settings";

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [rows, setRows] = useState<ConditionProgress[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The backend rejected our admin token (or we don't have one yet).
  const [needsToken, setNeedsToken] = useState(false);

  const load = useCallback(async () => {
    try {
      const [progressRes, sessionsRes] = await Promise.all([
        apiFetch("/conditions/progress"),
        apiFetch("/sessions"),
      ]);
      if (progressRes.status === 401 || sessionsRes.status === 401) {
        setNeedsToken(true);
        return;
      }
      if (!progressRes.ok) {
        throw new Error(`Could not load conditions (${progressRes.status})`);
      }
      if (!sessionsRes.ok) {
        throw new Error(`Could not load sessions (${sessionsRes.status})`);
      }
      setNeedsToken(false);
      setRows((await progressRes.json()) as ConditionProgress[]);
      setSessions((await sessionsRes.json()) as SessionSummary[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (needsToken) {
    return <TokenGate onSubmit={() => void load()} />;
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Study Admin</h1>
          <p>Group decision-making study — tracking, sessions, and exports.</p>
        </div>
        <nav className="tabs" aria-label="Views">
          <button
            type="button"
            className={view === "overview" ? "tab active" : "tab"}
            onClick={() => setView("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={view === "settings" ? "tab active" : "tab"}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
      </header>

      {error && <p className="error">{error}</p>}

      {view === "overview" ? (
        <Overview rows={rows} sessions={sessions} />
      ) : (
        <Settings rows={rows} onSaved={() => void load()} />
      )}
    </main>
  );
}

/** Shown when the backend requires ADMIN_API_TOKEN and ours is missing/wrong. */
function TokenGate({ onSubmit }: { onSubmit: () => void }) {
  const [token, setToken] = useState(getAdminToken());
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Study Admin</h1>
          <p>This dashboard is protected — enter the admin token.</p>
        </div>
      </header>
      <section className="section">
        <h2>Admin token</h2>
        <p className="hint">
          The value of ADMIN_API_TOKEN configured for the Session Manager.
        </p>
        <form
          className="copy-row"
          onSubmit={(e) => {
            e.preventDefault();
            setAdminToken(token.trim());
            onSubmit();
          }}
        >
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Admin token"
            aria-label="Admin token"
            autoFocus
          />
          <button type="submit">Unlock</button>
        </form>
      </section>
    </main>
  );
}
