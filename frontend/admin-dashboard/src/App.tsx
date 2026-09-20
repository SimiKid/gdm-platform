import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConditionProgress,
  RoundsResponse,
  SessionSummary,
  EtherpadStatus,
} from "@gdm/shared";
import Overview from "./components/Overview";
import Settings from "./components/Settings";
import Testing from "./components/Testing";
import { apiFetch, getAdminToken, setAdminToken } from "./api";

export { API_BASE, PARTICIPANT_BASE } from "./api";

/** How often the dashboard refreshes itself (drives the "Live" indicator). */
const POLL_MS = 5000;

type View = "overview" | "settings" | "testing";

export default function App() {
  const [view, setView] = useState<View>("overview");
  const [rows, setRows] = useState<ConditionProgress[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [rounds, setRounds] = useState<RoundsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [etherpad, setEtherpad] = useState<EtherpadStatus | null>(null);
  const [switching, setSwitching] = useState(false);
  const switchEpoch = useRef(0);
  const toggleEtherpad = async (enabled: boolean) => {
    switchEpoch.current += 1;
    const previous = etherpad;
    setEtherpad(current => current ? { ...current, enabled, state: enabled ? "starting" : "draining" } : current);
    setSwitching(true);
    try {
      const res = await apiFetch("/admin/etherpad", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message ?? "Could not change Etherpad mode");
      setEtherpad(body);
      setError(null);
    } catch (err) { setEtherpad(previous); setError(err instanceof Error ? err.message : "Could not change Etherpad mode"); }
    finally { switchEpoch.current += 1; setSwitching(false); }
  };
  // The backend rejected our admin token (or we don't have one yet).
  const [needsToken, setNeedsToken] = useState(false);
  const loadInFlight = useRef(false);

  const load = useCallback(async () => {
    if (loadInFlight.current) return;
    loadInFlight.current = true;
    const epoch = switchEpoch.current;
    try {
      const [progressRes, sessionsRes, roundsRes, etherpadRes] = await Promise.all([
        apiFetch("/conditions/progress"),
        apiFetch("/sessions"),
        apiFetch("/rounds"),
        apiFetch("/admin/etherpad"),
      ]);
      if (
        progressRes.status === 401 ||
        sessionsRes.status === 401 ||
        roundsRes.status === 401
      ) {
        setNeedsToken(true);
        return;
      }
      if (!progressRes.ok) {
        throw new Error(`Could not load conditions (${progressRes.status})`);
      }
      if (!sessionsRes.ok) {
        throw new Error(`Could not load sessions (${sessionsRes.status})`);
      }
      if (!roundsRes.ok) {
        throw new Error(`Could not load rounds (${roundsRes.status})`);
      }
      setNeedsToken(false);
      setRows((await progressRes.json()) as ConditionProgress[]);
      setSessions((await sessionsRes.json()) as SessionSummary[]);
      setRounds((await roundsRes.json()) as RoundsResponse);
      if (etherpadRes.ok) {
        const status = await etherpadRes.json();
        if (epoch === switchEpoch.current) setEtherpad(status);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    } finally {
      loadInFlight.current = false;
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

  const locked = switching || etherpad?.state === "starting" || etherpad?.state === "stopping";

  return (
    <main className="shell">
      {locked && <div className="workspace-busy" role="status" aria-live="polite"><span className="workspace-spinner" />{etherpad?.state === "stopping" ? "Stopping Etherpad…" : "Starting Etherpad…"} Settings are temporarily locked.</div>}
      <fieldset className="dashboard-controls" disabled={locked} aria-busy={locked}>
      <header className="topbar">
        <div>
          <h1>Study Admin</h1>
          <p>Group decision-making study: tracking, sessions, and exports.</p>
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
          <button
            type="button"
            className={view === "testing" ? "tab active" : "tab"}
            onClick={() => setView("testing")}
          >
            Testing
          </button>
        </nav>
      </header>

      {error && <p className="error">{error}</p>}

      {view === "overview" && (
        <Overview rows={rows} sessions={sessions} rounds={rounds} />
      )}
      {view === "settings" && (
        <Settings
          rows={rows}
          onSaved={() => void load()}
          rounds={rounds}
          lobbyCount={sessions.filter((s) => s.status === "waiting").length}
          etherpad={etherpad}
          onToggleEtherpad={enabled => void toggleEtherpad(enabled)}
        />
      )}
      {view === "testing" && (
        <Testing
          rows={rows}
          sessions={sessions}
          onSaved={() => void load()}
        />
      )}
      </fieldset>
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
          <p>This dashboard is protected. Please enter the admin token.</p>
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
