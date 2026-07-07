import { useEffect, useMemo, useState } from "react";
import type {
  ConditionProgress,
  Session,
  SessionStatus,
  SessionSummary,
} from "@gdm/shared";
import { PARTICIPANT_BASE, apiFetch, exportUrl } from "../api";

/** Researcher-facing wording for backend session states (wireframe: lobby/active). */
const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: "lobby",
  running: "active",
  completed: "completed",
  aborted: "aborted",
};

const EXPORTS = [
  { key: "sessions", label: "Everything (full sessions)" },
  { key: "messages", label: "Chat logs" },
  { key: "interventions", label: "Nudge events" },
  { key: "surveys", label: "Survey responses" },
] as const;

interface Props {
  rows: ConditionProgress[];
  sessions: SessionSummary[];
}

export default function Overview({ rows, sessions }: Props) {
  const liveCount = sessions.filter((s) => s.status === "running").length;
  const lobbyCount = sessions.filter((s) => s.status === "waiting").length;
  const totals = useMemo(
    () => ({
      completed: rows.reduce((sum, row) => sum + row.completed, 0),
      goal: rows.reduce((sum, row) => sum + row.goal, 0),
    }),
    [rows],
  );

  return (
    <>
      <section className="summary">
        <Metric label="Completed sessions" value={`${totals.completed} / ${totals.goal}`} />
        <Metric
          label="Active now"
          value={String(liveCount)}
          live={liveCount > 0}
        />
        <Metric label="In lobby" value={String(lobbyCount)} />
        <Metric label="Sessions total" value={String(sessions.length)} />
      </section>

      <div className="two-col">
        <StudyLinkCard rows={rows} />
        <ExportCard rows={rows} />
      </div>

      <ConditionTracking rows={rows} />
      <SessionsTable sessions={sessions} />
    </>
  );
}

function Metric({
  label,
  value,
  live = false,
}: {
  label: string;
  value: string;
  live?: boolean;
}) {
  return (
    <div>
      <span className="label">
        {label} {live && <span className="live-dot" aria-label="live" />}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

/** The one generic link researchers hand out (participants self-register). */
function StudyLinkCard({ rows }: { rows: ConditionProgress[] }) {
  const link = `${PARTICIPANT_BASE}/`;
  return (
    <section className="section">
      <h2>Study Link</h2>
      <p className="hint">
        Send this link to participants. Each click joins the study and is
        assigned to an active condition automatically.
      </p>
      <div className="copy-row">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <CopyButton text={link} />
      </div>
      <details>
        <summary>Pilot links (force a condition — testing only)</summary>
        {rows.map(({ condition }) => {
          const pilot = `${PARTICIPANT_BASE}/?conditionId=${condition.id}`;
          return (
            <div className="copy-row" key={condition.id}>
              <span className="pilot-name">{condition.name}</span>
              <input readOnly value={pilot} onFocus={(e) => e.target.select()} />
              <CopyButton text={pilot} />
            </div>
          );
        })}
      </details>
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

/** JSON/CSV downloads per data set, optionally restricted to conditions. */
function ExportCard({ rows }: { rows: ConditionProgress[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const query =
    selected.size > 0 ? `?conditionIds=${[...selected].join(",")}` : "";

  return (
    <section className="section">
      <h2>Export Data</h2>
      <div className="chips selectable">
        {rows.map(({ condition }) => (
          <label key={condition.id}>
            <input
              type="checkbox"
              checked={selected.has(condition.id)}
              onChange={() => toggle(condition.id)}
            />
            {condition.name}
          </label>
        ))}
      </div>
      <p className="hint">
        {selected.size > 0
          ? `Filtered to ${selected.size} condition(s).`
          : "All conditions included — tick conditions above to filter."}
      </p>
      <table className="export-table">
        <tbody>
          {EXPORTS.map(({ key, label }) => (
            <tr key={key}>
              <td>{label}</td>
              <td>
                <a
                  className="link-button"
                  href={exportUrl(`/export/${key}`, query)}
                  target="_blank"
                  rel="noreferrer"
                >
                  JSON
                </a>
                <a
                  className="link-button"
                  href={exportUrl(`/export/${key}.csv`, query)}
                  target="_blank"
                  rel="noreferrer"
                >
                  CSV
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** "# Completed per condition" — the wireframe's tracking block. */
function ConditionTracking({ rows }: { rows: ConditionProgress[] }) {
  return (
    <section className="section">
      <h2>Completed per Condition</h2>
      <div className="tracking">
        {rows.map((row) => {
          const pct =
            row.goal > 0 ? Math.min(100, (row.completed / row.goal) * 100) : 0;
          const remaining = Math.max(0, row.goal - row.completed);
          return (
            <div key={row.condition.id} className="tracking-row">
              <span className="tracking-name">
                {row.condition.name}
                {!row.condition.active && <em className="off"> (off)</em>}
              </span>
              <div className="bar">
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="tracking-count">
                {row.completed} / {row.goal}
                <span className="muted">{remaining} remaining</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SessionsTable({ sessions }: { sessions: SessionSummary[] }) {
  const [detail, setDetail] = useState<Session | null>(null);

  // Keep an open detail in sync with the dashboard poll (e.g. message counts
  // land when the chat service finalizes the session).
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailId) return;
    void apiFetch(`/admin/sessions/${detailId}`).then(async (res) => {
      if (res.ok) setDetail((await res.json()) as Session);
    });
  }, [detailId, sessions]);

  async function open(id: string) {
    if (detail?.id === id) {
      setDetail(null); // click again to close
      return;
    }
    const res = await apiFetch(`/admin/sessions/${id}`);
    if (res.ok) setDetail((await res.json()) as Session);
  }

  return (
    <section className="section">
      <h2>Sessions</h2>
      {sessions.length === 0 && <p className="empty">No sessions yet.</p>}
      {sessions.length > 0 && (
        <div className="table-wrap compact" aria-label="Sessions">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Condition</th>
                <th>Status</th>
                <th>People</th>
                <th>Started</th>
                <th>Completed</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  className={
                    detail?.id === session.id ? "clickable selected" : "clickable"
                  }
                  onClick={() => void open(session.id)}
                >
                  <td>
                    <strong>{session.id.slice(0, 8)}</strong>
                  </td>
                  <td>{session.conditionName}</td>
                  <td>
                    <span className={`status ${session.status}`}>
                      {STATUS_LABEL[session.status]}
                    </span>
                  </td>
                  <td>
                    {session.participantCount} / {session.groupSize}
                  </td>
                  <td>{formatTime(session.startedAt)}</td>
                  <td>{formatTime(session.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail && <SessionDetail session={detail} />}
    </section>
  );
}

/** Compact, readable session inspector (replaces the old raw JSON dump). */
function SessionDetail({ session }: { session: Session }) {
  return (
    <div className="session-detail">
      <div className="detail">
        <Fact label="Condition" value={session.condition.name} />
        <Fact
          label="Participants"
          value={
            // No names are collected by design — fall back to the token.
            session.participants
              .map((p) => p.name || p.trackingToken.slice(0, 8))
              .join(", ") || "none"
          }
        />
        <Fact label="Messages" value={String(session.chat.messages.length)} />
        <Fact label="Nudges" value={String(session.interventions.length)} />
        <Fact
          label="Ranking edits"
          value={String(session.rankingHistory?.length ?? 0)}
        />
        <Fact label="Room" value={session.roomId ?? "not provisioned"} />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatTime(value?: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
