import { useCallback, useEffect, useState } from "react";
import type { ConditionProgress, SessionSummary } from "@gdm/shared";
import Overview from "./components/Overview";
import Settings from "./components/Settings";

export const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
export const PARTICIPANT_BASE =
  import.meta.env.VITE_PARTICIPANT_URL ?? "http://localhost:3000";

/** How often the dashboard refreshes itself (drives the "Live" indicator). */
const POLL_MS = 5000;

type View = "overview" | "settings";

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [rows, setRows] = useState<ConditionProgress[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [progressRes, sessionsRes] = await Promise.all([
        fetch(`${API_BASE}/conditions/progress`),
        fetch(`${API_BASE}/sessions`),
      ]);
      if (!progressRes.ok) {
        throw new Error(`Could not load conditions (${progressRes.status})`);
      }
      if (!sessionsRes.ok) {
        throw new Error(`Could not load sessions (${sessionsRes.status})`);
      }
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
