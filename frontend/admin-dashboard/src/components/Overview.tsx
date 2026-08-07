import { useEffect, useMemo, useState } from "react";
import type {
  ConditionProgress,
  RoundsResponse,
  Session,
  SessionStatus,
  SessionSummary,
} from "@gdm/shared";
import { PARTICIPANT_BASE, apiFetch, isTestCondition } from "../api";
import AuthenticatedDownloadLink from "./AuthenticatedDownloadLink";

/** Researcher-facing wording for backend session states (wireframe: lobby/active). */
const STATUS_LABEL: Record<SessionStatus, string> = {
  waiting: "lobby",
  provisioning: "starting",
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
  rounds: RoundsResponse | null;
}

export default function Overview({ rows, sessions, rounds }: Props) {
  // Test residue (E2E arms) stays out of the study numbers and lists below.
  const studyRows = useMemo(
    () => rows.filter((row) => !isTestCondition(row.condition.id)),
    [rows],
  );
  const studySessions = useMemo(
    () => sessions.filter((s) => !isTestCondition(s.conditionId)),
    [sessions],
  );
  const liveCount = studySessions.filter(
    (s) => s.status === "running" || s.status === "provisioning",
  ).length;
  const lobbyCount = studySessions.filter((s) => s.status === "waiting").length;
  const totals = useMemo(
    () => ({
      completed: studyRows.reduce((sum, row) => sum + row.completed, 0),
      goal: studyRows.reduce((sum, row) => sum + row.goal, 0),
    }),
    [studyRows],
  );

  const currentRound = rounds?.rounds.find(
    (round) => round.number === rounds.currentRound,
  );

  return (
    <>
      <section className="summary">
        {rounds && (
          <Metric
            label={
              currentRound?.label
                ? `Current round (${currentRound.label})`
                : "Current round"
            }
            value={`Round ${rounds.currentRound}`}
          />
        )}
        <Metric
          label="Completed sessions (round)"
          value={`${totals.completed} / ${totals.goal}`}
        />
        <Metric
          label="Active now"
          value={String(liveCount)}
          live={liveCount > 0}
        />
        <Metric label="In lobby" value={String(lobbyCount)} />
        <Metric label="Sessions total" value={String(studySessions.length)} />
      </section>

      <div className="two-col">
        <StudyLinkCard />
        <ExportCard />
      </div>

      <ConditionTracking rows={studyRows} />
      <SessionsTable sessions={studySessions} />
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
function StudyLinkCard() {
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
    </section>
  );
}

/** Forced-condition links are isolated in the dedicated Testing view. */
export function PilotLinksCard({ rows }: { rows: ConditionProgress[] }) {
  return (
    <section className="section">
      <h2>Pilot Links</h2>
      <p className="hint">
        Open a participant flow in a specific study condition for manual
        testing. Do not distribute these links to recruited participants.
      </p>
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
        <AuthenticatedDownloadLink className="link-button secondary" path="/export/sessions" filename="detailed_data.json">
          Full Data (JSON)
        </AuthenticatedDownloadLink>
        <AuthenticatedDownloadLink className="link-button" path="/export/sessions.csv" filename="overview.csv">
          Overview (CSV)
        </AuthenticatedDownloadLink>
      </div>
      <details className="export-advanced">
        <summary>Individual datasets</summary>
        <table className="export-table">
          <tbody>
            {INDIVIDUAL_EXPORTS.map(({ key, label }) => (
              <tr key={key}>
                <td>{label}</td>
                <td>
                  <AuthenticatedDownloadLink className="link-button" path={`/export/${key}`} filename={`${key}.json`}>
                    JSON
                  </AuthenticatedDownloadLink>
                  <AuthenticatedDownloadLink className="link-button" path={`/export/${key}.csv`} filename={`${key}.csv`}>
                    CSV
                  </AuthenticatedDownloadLink>
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
function ConditionTracking({ rows }: { rows: ConditionProgress[] }) {
  return (
    <section className="section">
      <h2>Completed per Condition (current round)</h2>
      <div className="tracking">
        {rows.map((row) => (
          <TrackingRow key={row.condition.id} row={row} />
        ))}
      </div>
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

export function SessionsTable({
  sessions,
  title = "Sessions",
  emptyMessage = "No sessions yet.",
  label = "Sessions",
}: {
  sessions: SessionSummary[];
  title?: string;
  emptyMessage?: string;
  label?: string;
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

  return (
    <section className="section">
      <h2>{title}</h2>
      {sessions.length === 0 && <p className="empty">{emptyMessage}</p>}
      {sessions.length > 0 && (
        <SessionRows
          sessions={sessions}
          selectedId={detail?.id}
          onOpen={open}
          label={label}
        />
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
            <th>Round</th>
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
              <td>{session.roundId}</td>
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
  if (!value) return "not yet";
  return new Date(value).toLocaleString();
}
