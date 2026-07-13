import { useEffect, useMemo, useState } from "react";
import type {
  ConditionProgress,
  Session,
  SessionStatus,
  SessionSummary,
} from "@gdm/shared";
import { PARTICIPANT_BASE, apiFetch, exportUrl, isTestCondition } from "../api";

/** Researcher-facing wording for backend session states (wireframe: lobby/active). */
const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: "lobby",
  running: "active",
  completed: "completed",
  aborted: "aborted",
};

const INDIVIDUAL_EXPORTS = [
  { key: "messages", label: "Chat logs" },
  { key: "interventions", label: "Nudge events" },
  { key: "surveys", label: "Survey responses" },
  { key: "contributions", label: "Contributions & behavioral telemetry" },
] as const;


interface Props {
  rows: ConditionProgress[];
  sessions: SessionSummary[];
}

export default function Overview({ rows, sessions }: Props) {
  // Test residue (E2E arms) stays out of the study numbers and lists below.
  const studyRows = useMemo(
    () => rows.filter((row) => !isTestCondition(row.condition.id)),
    [rows],
  );
  const testRows = useMemo(
    () => rows.filter((row) => isTestCondition(row.condition.id)),
    [rows],
  );
  const studySessions = useMemo(
    () => sessions.filter((s) => !isTestCondition(s.conditionId)),
    [sessions],
  );
  const testSessions = useMemo(
    () => sessions.filter((s) => isTestCondition(s.conditionId)),
    [sessions],
  );
  const liveCount = studySessions.filter((s) => s.status === "running").length;
  const lobbyCount = studySessions.filter((s) => s.status === "waiting").length;
  const totals = useMemo(
    () => ({
      completed: studyRows.reduce((sum, row) => sum + row.completed, 0),
      goal: studyRows.reduce((sum, row) => sum + row.goal, 0),
    }),
    [studyRows],
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
        <Metric label="Sessions total" value={String(studySessions.length)} />
      </section>

      <div className="two-col">
        <StudyLinkCard rows={studyRows} />
        <ExportCard />
      </div>

      <ConditionTracking rows={studyRows} testRows={testRows} />
      <SessionsTable sessions={studySessions} testSessions={testSessions} />
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

/** JSON/CSV downloads per data set. */
function ExportCard() {
  return (
    <section className="section">
      <h2>Export Data</h2>
      <div className="download-primary">
        <a className="link-button secondary" href={exportUrl("/export/sessions", "")} download="detailed_data.json">
          Full Data (JSON)
        </a>
        <a className="link-button" href={exportUrl("/export/sessions.csv", "")} download="overview.csv">
          Overview (CSV)
        </a>
      </div>
      <details className="export-advanced">
        <summary>Individual datasets</summary>
        <table className="export-table">
          <tbody>
            {INDIVIDUAL_EXPORTS.map(({ key, label }) => (
              <tr key={key}>
                <td>{label}</td>
                <td>
                  <a className="link-button" href={exportUrl(`/export/${key}`, "")} target="_blank" rel="noreferrer">
                    JSON
                  </a>
                  <a className="link-button" href={exportUrl(`/export/${key}.csv`, "")} target="_blank" rel="noreferrer">
                    CSV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

/** "# Completed per condition" — the wireframe's tracking block. */
function ConditionTracking({
  rows,
  testRows,
}: {
  rows: ConditionProgress[];
  testRows: ConditionProgress[];
}) {
  const activeTestCount = testRows.filter((row) => row.condition.active).length;
  return (
    <section className="section">
      <h2>Completed per Condition</h2>
      <div className="tracking">
        {rows.map((row) => (
          <TrackingRow key={row.condition.id} row={row} />
        ))}
      </div>
      {testRows.length > 0 && (
        <details className="test-conditions" open={activeTestCount > 0}>
          <summary>
            Test conditions from E2E runs ({testRows.length})
            {activeTestCount > 0 && (
              <strong className="bad">
                {" "}
                — {activeTestCount} still active! Switch off in Settings.
              </strong>
            )}
          </summary>
          <div className="tracking">
            {testRows.map((row) => (
              <TrackingRow key={row.condition.id} row={row} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function TrackingRow({ row }: { row: ConditionProgress }) {
  const pct =
    row.goal > 0 ? Math.min(100, (row.completed / row.goal) * 100) : 0;
  const remaining = Math.max(0, row.goal - row.completed);
  return (
    <div className="tracking-row">
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
}

function SessionsTable({
  sessions,
  testSessions,
}: {
  sessions: SessionSummary[];
  testSessions: SessionSummary[];
}) {
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

  const activeTestCount = testSessions.filter(
    (s) => s.status === "running" || s.status === "waiting",
  ).length;

  return (
    <section className="section">
      <h2>Sessions</h2>
      {sessions.length === 0 && <p className="empty">No sessions yet.</p>}
      {sessions.length > 0 && (
        <SessionRows
          sessions={sessions}
          selectedId={detail?.id}
          onOpen={open}
          label="Sessions"
        />
      )}
      {testSessions.length > 0 && (
        <details className="test-conditions" open={activeTestCount > 0}>
          <summary>
            Sessions from E2E runs ({testSessions.length})
            {activeTestCount > 0 && (
              <strong className="bad"> — {activeTestCount} still open!</strong>
            )}
          </summary>
          <SessionRows
            sessions={testSessions}
            selectedId={detail?.id}
            onOpen={open}
            label="E2E sessions"
          />
        </details>
      )}
      {detail && <SessionDetail session={detail} />}
    </section>
  );
}

function SessionRows({
  sessions,
  selectedId,
  onOpen,
  label,
}: {
  sessions: SessionSummary[];
  selectedId?: string;
  onOpen: (id: string) => Promise<void>;
  label: string;
}) {
  return (
    <div className="table-wrap compact" aria-label={label}>
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
                selectedId === session.id ? "clickable selected" : "clickable"
              }
              onClick={() => void onOpen(session.id)}
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
  );
}

/** Compact, readable session inspector (replaces the old raw JSON dump). */
function SessionDetail({ session }: { session: Session }) {
  return (
    <div className="session-detail">
      <div className="detail">
        <Fact label="Condition" value={session.condition.name} />
        <Fact label="Bot mode" value={session.condition.config.interventionMode} />
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
          label="Behavior events"
          value={String(session.behavioralEvents.length)}
        />
        <Fact
          label="Semantic classifications"
          value={String(session.contributionClassifications.length)}
        />
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
