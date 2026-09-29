import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { isTestCondition } from "@gdm/shared";
import type {
  ConditionProgress,
  RoundsResponse,
  Session,
  SessionSummary,
} from "@gdm/shared";
import { PARTICIPANT_BASE, apiFetch } from "../api";
import { STATUS_LABEL } from "../labels";
import { useTimeout } from "../use-timeout";
import AuthenticatedDownloadLink from "./AuthenticatedDownloadLink";
import ProgressBar from "./ProgressBar";
import SessionDetail from "./SessionDetail";

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
        {label} {live && <span className="live-dot" role="img" aria-label="live" />}
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
        <CopyField value={link} />
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
            <CopyField value={pilot} />
          </div>
        );
      })}
    </section>
  );
}

/**
 * Read-only link plus a copy button. Where the Clipboard API is unavailable
 * or refused (plain-http origin, denied permission) the link is selected
 * instead, so the researcher can copy it with the keyboard.
 */
function CopyField({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const input = useRef<HTMLInputElement>(null);
  const later = useTimeout();

  function copy() {
    const write = navigator.clipboard?.writeText(value) ?? Promise.reject(new Error("no clipboard"));
    write.then(
      () => {
        setState("copied");
        later(() => setState("idle"), 1500);
      },
      () => {
        setState("manual");
        input.current?.focus();
        input.current?.select();
        later(() => setState("idle"), 4000);
      },
    );
  }

  return (
    <>
      <input ref={input} readOnly value={value} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy}>
        {state === "copied" ? "Copied ✓" : state === "manual" ? "Press Ctrl/⌘+C" : "Copy"}
      </button>
    </>
  );
}

/** JSON/CSV downloads per data set. */
function ExportCard() {
  return (
    <section className="section">
      <h2>Export Data</h2>
      <div className="download-primary">
        <AuthenticatedDownloadLink className="link-button" path="/export/research-data.zip" filename="research_data.zip">
          Research Data (CSV)
        </AuthenticatedDownloadLink>
      </div>
      <details className="export-advanced">
        <summary>Advanced</summary>
        <table className="export-table">
          <tbody>
            <tr>
              <td>Full data dump</td>
              <td>
                <AuthenticatedDownloadLink className="link-button" path="/export/sessions" filename="detailed_data.json">
                  JSON
                </AuthenticatedDownloadLink>
              </td>
            </tr>
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
  const remaining = Math.max(0, row.goal - row.completed);
  return (
    <div className="tracking-row">
      <span className="tracking-name">
        {row.condition.name}
        {!row.condition.active && <em className="off"> (off)</em>}
      </span>
      <ProgressBar completed={row.completed} goal={row.goal} />
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
  // The open row is tracked separately from its loaded detail: a response
  // only lands if its session is still the open one, so a slow reply can
  // neither re-open a collapsed inspector nor show another session.
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Session | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Load the open detail, and refresh it with every dashboard poll (e.g.
  // message counts land when the chat service finalizes the session).
  useEffect(() => {
    if (!openId) return;
    const request = new AbortController();
    apiFetch(`/admin/sessions/${openId}`, { signal: request.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load this session (${res.status}).`);
        const loaded = (await res.json()) as Session;
        if (request.signal.aborted) return;
        setDetail(loaded);
        setDetailError(null);
      })
      .catch((err: unknown) => {
        if (request.signal.aborted) return;
        setDetailError(err instanceof Error ? err.message : "Could not load this session.");
      });
    return () => request.abort();
  }, [openId, sessions]);

  function toggle(id: string) {
    setOpenId((current) => (current === id ? null : id)); // click again to close
    setDetail(null);
    setDetailError(null);
  }

  return (
    <section className="section">
      <h2>{title}</h2>
      {sessions.length === 0 && <p className="empty">{emptyMessage}</p>}
      {sessions.length > 0 && (
        <SessionRows
          sessions={sessions}
          openId={openId}
          detail={detail?.id === openId ? detail : null}
          detailError={detailError}
          onToggle={toggle}
          label={label}
        />
      )}
    </section>
  );
}

const COLUMNS = 7;

function SessionRows({
  sessions,
  openId,
  detail,
  detailError,
  onToggle,
  label,
}: {
  sessions: SessionSummary[];
  openId: string | null;
  detail: Session | null;
  detailError: string | null;
  onToggle: (id: string) => void;
  label: string;
}) {
  const selectedRow = useRef<HTMLTableRowElement>(null);

  // The height cap is lifted while a session is expanded, which resets the
  // list's own scroll position — bring the opened row back into view.
  useEffect(() => {
    if (openId) selectedRow.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [openId]);

  return (
    // Uncapped while a session is expanded so the inspector grows with the
    // page instead of scrolling inside the 420px list box.
    <div className={openId ? "table-wrap" : "table-wrap compact"} aria-label={label}>
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
            <Fragment key={session.id}>
              <tr
                ref={openId === session.id ? selectedRow : undefined}
                className={
                  openId === session.id ? "clickable selected" : "clickable"
                }
                tabIndex={0}
                aria-expanded={openId === session.id}
                onClick={() => onToggle(session.id)}
                onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  onToggle(session.id);
                }}
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
              {openId === session.id && (
                <tr className="detail-row">
                  <td colSpan={COLUMNS}>
                    {detailError && (
                      <p className="error" role="alert">
                        {detailError}
                      </p>
                    )}
                    {detail ? (
                      <SessionDetail session={detail} />
                    ) : (
                      !detailError && <p className="empty">Loading session…</p>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTime(value?: string): string {
  if (!value) return "not yet";
  return new Date(value).toLocaleString();
}
