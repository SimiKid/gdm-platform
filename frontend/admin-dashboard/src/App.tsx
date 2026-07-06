import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  Condition,
  ConditionProgress,
  InterventionMode,
  InterventionSummary,
  Session,
  SessionSummary,
} from "@gdm/shared";

const API_BASE =
  import.meta.env.VITE_SESSION_MANAGER_URL ?? "http://localhost:3001/api";
const PARTICIPANT_BASE =
  import.meta.env.VITE_PARTICIPANT_URL ?? "http://localhost:3000";

const MODES: InterventionMode[] = [
  "public-neutral",
  "public-engaging",
  "private-neutral",
  "private-engaging",
];

type SaveState = Record<string, "idle" | "saving" | "saved" | "error">;

export default function App() {
  const [rows, setRows] = useState<ConditionProgress[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [interventions, setInterventions] = useState<InterventionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({});
  const [error, setError] = useState<string | null>(null);

  const totalCompleted = useMemo(
    () => rows.reduce((sum, row) => sum + row.completed, 0),
    [rows],
  );
  const totalGoal = useMemo(
    () => rows.reduce((sum, row) => sum + row.goal, 0),
    [rows],
  );

  async function load() {
    setError(null);
    const [progressRes, sessionsRes, interventionsRes] = await Promise.all([
      fetch(`${API_BASE}/conditions/progress`),
      fetch(`${API_BASE}/sessions`),
      fetch(`${API_BASE}/interventions`),
    ]);
    if (!progressRes.ok) throw new Error(`Could not load conditions (${progressRes.status})`);
    if (!sessionsRes.ok) throw new Error(`Could not load sessions (${sessionsRes.status})`);
    if (!interventionsRes.ok) {
      throw new Error(`Could not load interventions (${interventionsRes.status})`);
    }
    setRows((await progressRes.json()) as ConditionProgress[]);
    setSessions((await sessionsRes.json()) as SessionSummary[]);
    setInterventions((await interventionsRes.json()) as InterventionSummary[]);
  }

  useEffect(() => {
    void load().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : "Could not load dashboard");
    });
  }, []);

  function updateCondition(id: string, next: Condition) {
    setRows((current) =>
      current.map((row) =>
        row.condition.id === id
          ? { ...row, condition: next, goal: next.goal }
          : row,
      ),
    );
  }

  async function save(condition: Condition) {
    setSaveState((state) => ({ ...state, [condition.id]: "saving" }));
    try {
      const res = await fetch(`${API_BASE}/conditions/${condition.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ condition }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const saved = (await res.json()) as Condition;
      updateCondition(condition.id, saved);
      setSaveState((state) => ({ ...state, [condition.id]: "saved" }));
    } catch {
      setSaveState((state) => ({ ...state, [condition.id]: "error" }));
    }
  }

  async function loadSession(id: string) {
    const res = await fetch(`${API_BASE}/sessions/${id}`);
    if (!res.ok) throw new Error(`Could not load session (${res.status})`);
    setSelectedSession((await res.json()) as Session);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Study Admin</h1>
          <p>Condition setup, pilot links, sessions, exports, and bot audit.</p>
        </div>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      <section className="summary">
        <Metric label="Completed" value={totalCompleted} />
        <Metric label="Goal" value={totalGoal} />
        <Metric
          label="Active Conditions"
          value={rows.filter((row) => row.condition.active).length}
        />
        <Metric label="Sessions" value={sessions.length} />
      </section>

      <section className="actions">
        <a href={`${API_BASE}/export/sessions`} target="_blank" rel="noreferrer">
          JSON export
        </a>
        <a
          href={`${API_BASE}/export/sessions.csv`}
          target="_blank"
          rel="noreferrer"
        >
          CSV export
        </a>
      </section>

      {error && <p className="error">{error}</p>}

      <Section title="Conditions">
        <div className="table-wrap" aria-label="Condition settings">
          <table>
            <thead>
              <tr>
                <th>Active</th>
                <th>Condition</th>
                <th>Mode</th>
                <th>Progress</th>
                <th>Goal</th>
                <th>Minutes</th>
                <th>People</th>
                <th>Threshold</th>
                <th>Windows</th>
                <th>Score</th>
                <th>Pilot Link</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ConditionRow
                  key={row.condition.id}
                  row={row}
                  state={saveState[row.condition.id] ?? "idle"}
                  onChange={(next) => updateCondition(row.condition.id, next)}
                  onSave={() => void save(row.condition)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <section className="two-col">
        <Section title="Sessions">
          <div className="table-wrap compact" aria-label="Sessions">
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Condition</th>
                  <th>Status</th>
                  <th>People</th>
                  <th>Messages</th>
                  <th>Bot</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr
                    key={session.id}
                    className="clickable"
                    onClick={() => void loadSession(session.id)}
                  >
                    <td>
                      <strong>{session.id.slice(0, 8)}</strong>
                      <span className="muted">{formatTime(session.createdAt)}</span>
                    </td>
                    <td>{session.conditionName}</td>
                    <td>
                      <span className={`status ${session.status}`}>
                        {session.status}
                      </span>
                    </td>
                    <td>
                      {session.participantCount} / {session.groupSize}
                    </td>
                    <td>{session.messageCount}</td>
                    <td>{session.interventionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <SessionDetail session={selectedSession} />
      </section>

      <Section title="Intervention Audit">
        <div className="interventions">
          {interventions.length === 0 && (
            <p className="empty">No bot interventions recorded yet.</p>
          )}
          {interventions.slice(0, 20).map((item, index) => (
            <article key={`${item.sessionId}-${item.timestamp}-${index}`}>
              <div className="audit-head">
                <strong>{item.mode}</strong>
                <span>{formatTime(item.timestamp)}</span>
              </div>
              <p>{item.message}</p>
              <div className="chips">
                {item.targets.map((target) => (
                  <span key={target.userId}>Target: {target.identityName}</span>
                ))}
                {item.quietMembers.map((member) => (
                  <span key={member.userId}>Quiet: {member.identityName}</span>
                ))}
              </div>
              <small>
                {item.contributionSplit
                  .map((entry) => `${entry.identityName} ${Math.round(entry.share * 100)}%`)
                  .join(" | ")}
              </small>
            </article>
          ))}
        </div>
      </Section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ConditionRow({
  row,
  state,
  onChange,
  onSave,
}: {
  row: ConditionProgress;
  state: SaveState[string];
  onChange: (condition: Condition) => void;
  onSave: () => void;
}) {
  const { condition } = row;
  const config = condition.config;

  function patch(next: Partial<Condition>) {
    onChange({ ...condition, ...next });
  }

  function patchConfig(next: Partial<Condition["config"]>) {
    onChange({
      ...condition,
      config: {
        ...config,
        ...next,
        scoreWeights: {
          ...config.scoreWeights,
          ...next.scoreWeights,
        },
      },
    });
  }

  const pct =
    condition.goal > 0
      ? Math.min(100, (row.completed / condition.goal) * 100)
      : 0;
  const pilotLink = `${PARTICIPANT_BASE}/?p=pilot-${condition.id}-1&conditionId=${condition.id}`;

  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={condition.active}
          onChange={(e) => patch({ active: e.target.checked })}
          aria-label={`${condition.name} active`}
        />
      </td>
      <td>
        <strong>{condition.name}</strong>
        <span className="muted">{condition.id}</span>
      </td>
      <td>
        <select
          value={config.interventionMode}
          onChange={(e) =>
            patchConfig({ interventionMode: e.target.value as InterventionMode })
          }
        >
          {MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </td>
      <td>
        <div className="progress-label">
          {row.completed} / {condition.goal}
        </div>
        <div className="bar">
          <span style={{ width: `${pct}%` }} />
        </div>
      </td>
      <td>
        <NumberInput
          value={condition.goal}
          min={0}
          onChange={(goal) => patch({ goal })}
        />
      </td>
      <td>
        <NumberInput
          value={condition.durationMinutes}
          min={1}
          onChange={(durationMinutes) => patch({ durationMinutes })}
        />
      </td>
      <td>
        <NumberInput
          value={condition.groupSize}
          min={2}
          onChange={(groupSize) => patch({ groupSize })}
        />
      </td>
      <td>
        <NumberInput
          value={config.contributionThreshold}
          min={0}
          max={1}
          step={0.05}
          onChange={(contributionThreshold) =>
            patchConfig({ contributionThreshold })
          }
        />
      </td>
      <td className="stacked-inputs wide">
        <label>
          Score
          <NumberInput
            value={config.contributionWindowMinutes}
            min={1}
            onChange={(contributionWindowMinutes) =>
              patchConfig({ contributionWindowMinutes })
            }
          />
        </label>
        <label>
          Rate
          <NumberInput
            value={config.interventionWindowMinutes}
            min={1}
            onChange={(interventionWindowMinutes) =>
              patchConfig({ interventionWindowMinutes })
            }
          />
        </label>
        <label>
          Start
          <NumberInput
            value={config.protectedStartMinutes}
            min={0}
            onChange={(protectedStartMinutes) =>
              patchConfig({ protectedStartMinutes })
            }
          />
        </label>
        <label>
          End
          <NumberInput
            value={config.protectedEndMinutes}
            min={0}
            onChange={(protectedEndMinutes) =>
              patchConfig({ protectedEndMinutes })
            }
          />
        </label>
      </td>
      <td className="stacked-inputs">
        <label>
          Msg
          <NumberInput
            value={config.scoreWeights.messages}
            min={0}
            step={0.1}
            onChange={(messages) =>
              patchConfig({ scoreWeights: { ...config.scoreWeights, messages } })
            }
          />
        </label>
        <label>
          Char
          <NumberInput
            value={config.scoreWeights.characters}
            min={0}
            step={0.005}
            onChange={(characters) =>
              patchConfig({
                scoreWeights: { ...config.scoreWeights, characters },
              })
            }
          />
        </label>
      </td>
      <td>
        <a className="link-button" href={pilotLink} target="_blank" rel="noreferrer">
          Open
        </a>
      </td>
      <td>
        <button type="button" onClick={onSave} disabled={state === "saving"}>
          {state === "saving" ? "Saving" : "Save"}
        </button>
        {state === "saved" && <span className="ok">Saved</span>}
        {state === "error" && <span className="bad">Error</span>}
      </td>
    </tr>
  );
}

function SessionDetail({ session }: { session: Session | null }) {
  if (!session) {
    return (
      <Section title="Session Detail">
        <p className="empty">Select a session to inspect surveys, messages, rankings, and interventions.</p>
      </Section>
    );
  }

  return (
    <Section title="Session Detail">
      <div className="detail">
        <div>
          <span className="label">Session</span>
          <strong>{session.id.slice(0, 8)}</strong>
        </div>
        <div>
          <span className="label">Condition</span>
          <strong>{session.condition.name}</strong>
        </div>
        <div>
          <span className="label">Participants</span>
          <strong>{session.participants.length}</strong>
        </div>
        <div>
          <span className="label">Messages</span>
          <strong>{session.chat.messages.length}</strong>
        </div>
        <div>
          <span className="label">Ranking Edits</span>
          <strong>{session.rankingHistory?.length ?? 0}</strong>
        </div>
        <div>
          <span className="label">Interventions</span>
          <strong>{session.interventions.length}</strong>
        </div>
      </div>
      <pre>{JSON.stringify(session, null, 2)}</pre>
    </Section>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function formatTime(value?: string): string {
  if (!value) return "";
  return new Date(value).toLocaleString();
}
