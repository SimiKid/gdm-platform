import { useMemo, useState } from "react";
import type {
  Condition,
  ConditionProgress,
  SessionSummary,
} from "@gdm/shared";
import { isTestCondition } from "../api";
import { PilotLinksCard, SessionsTable } from "./Overview";
import { ArmBadges, putCondition } from "./Settings";

interface Props {
  rows: ConditionProgress[];
  sessions: SessionSummary[];
  onSaved: () => void;
}

/** Test conditions listed before "Show all" — roughly one full E2E run. */
const COLLAPSED_ROWS = 10;

const OPEN_STATUSES = new Set(["provisioning", "waiting", "running"]);

/**
 * Manual pilot links first; automated E2E residue reduced to a status line,
 * with the full history one click away. E2E runs start from the terminal —
 * the production Overview and Settings views deliberately contain none of it.
 */
export default function Testing({ rows, sessions, onSaved }: Props) {
  const studyRows = useMemo(
    () => rows.filter((row) => !isTestCondition(row.condition.id)),
    [rows],
  );
  // Still-recruiting rows first (they need action), then newest run first.
  const testRows = useMemo(
    () =>
      rows
        .filter((row) => isTestCondition(row.condition.id))
        .sort(
          (a, b) =>
            Number(b.condition.active) - Number(a.condition.active) ||
            (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
        ),
    [rows],
  );
  // Unfinished sessions first so the status line points somewhere visible.
  const testSessions = useMemo(
    () =>
      sessions
        .filter((session) => isTestCondition(session.conditionId))
        .sort(
          (a, b) =>
            Number(OPEN_STATUSES.has(b.status)) -
            Number(OPEN_STATUSES.has(a.status)),
        ),
    [sessions],
  );
  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of testSessions) {
      counts.set(session.conditionId, (counts.get(session.conditionId) ?? 0) + 1);
    }
    return counts;
  }, [testSessions]);
  const activeRows = testRows.filter((row) => row.condition.active);
  const openTestSessions = testSessions.filter((session) =>
    OPEN_STATUSES.has(session.status),
  ).length;
  const [showHistory, setShowHistory] = useState(false);
  const hasResidue = testRows.length > 0 || testSessions.length > 0;

  return (
    <>
      {activeRows.length > 0 && (
        <section className="section test-warning" aria-label="Active test conditions">
          <p className="bad">
            {activeRows.length} automated test{" "}
            {activeRows.length === 1 ? "condition is" : "conditions are"} still
            recruiting, so real participants could be assigned to a test
            session. A test run was probably interrupted. Switch{" "}
            {activeRows.length === 1 ? "it" : "them"} off:
          </p>
          <ul className="active-tests">
            {activeRows.map((row) => (
              <li key={row.condition.id}>
                <strong>{row.condition.name}</strong>
                {row.createdAt && (
                  <span className="muted">created {formatCreated(row.createdAt)}</span>
                )}
                <SwitchOffButton conditions={[row.condition]} label={`Switch off ${row.condition.name}`} onSaved={onSaved} />
              </li>
            ))}
          </ul>
          {activeRows.length > 1 && (
            <SwitchOffButton
              conditions={activeRows.map((row) => row.condition)}
              label={`Switch off all ${activeRows.length}`}
              onSaved={onSaved}
            />
          )}
        </section>
      )}

      <PilotLinksCard rows={studyRows} />

      <section className="section">
        <h2>Automated Tests</h2>
        <p className="hint">
          Automated end-to-end (E2E) tests are started from a terminal on a
          computer running the local stack (<code>pnpm test:e2e</code>), not
          from this page. Each run creates its own temporary test conditions and
          switches them off when it finishes. Test data never appears in the
          Overview or in the research exports.
        </p>
        <ul className="test-summary" aria-label="Automated test status">
          {!hasResidue && <li>No automated test has run on this stack yet.</li>}
          {testRows.length > 0 && (
            <li className={activeRows.length > 0 ? "bad" : "ok"}>
              {activeRows.length > 0
                ? `${activeRows.length} of ${plural(testRows.length, "test condition")} still recruiting — see the warning at the top.`
                : `All ${plural(testRows.length, "test condition")} are switched off.`}
            </li>
          )}
          {testSessions.length > 0 && (
            <li className={openTestSessions > 0 ? "bad" : undefined}>
              {plural(testSessions.length, "test session")}
              {openTestSessions > 0 &&
                ` — ${openTestSessions} never finished because a test run was interrupted; ${openTestSessions === 1 ? "it is" : "they are"} listed first in the history.`}
            </li>
          )}
        </ul>
        {hasResidue && (
          <button
            type="button"
            className="link-button secondary"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((current) => !current)}
          >
            {showHistory ? "Hide test history" : "Show test history"}
          </button>
        )}
      </section>

      {showHistory && (
        <>
          <SessionsTable
            sessions={testSessions}
            title="Test Sessions"
            emptyMessage="No test sessions."
            label="E2E test sessions"
          />
          <TestConditions
            rows={testRows}
            sessionCounts={sessionCounts}
            onSaved={onSaved}
          />
        </>
      )}
    </>
  );
}

function TestConditions({
  rows,
  sessionCounts,
  onSaved,
}: {
  rows: ConditionProgress[];
  sessionCounts: Map<string, number>;
  onSaved: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <section className="section">
      <h2>Test Conditions</h2>
      <p className="hint">
        A test condition can only be switched off here, never on, because an
        active one would recruit real participants.
      </p>
      {rows.length === 0 ? (
        <p className="empty">No test conditions.</p>
      ) : (
        <>
          <div className="table-wrap" aria-label="E2E test conditions">
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Created</th>
                  <th className="num">Sessions</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.condition.id}>
                    <td>
                      <strong>{row.condition.name}</strong>
                      <ArmBadges condition={row.condition} />
                    </td>
                    <td>
                      {row.createdAt ? formatCreated(row.createdAt) : "unknown"}
                    </td>
                    <td className="num">
                      {sessionCounts.get(row.condition.id) ?? 0}
                    </td>
                    <td>
                      {row.condition.active ? (
                        <span className="test-status">
                          <span className="pill on">recruiting</span>
                          <SwitchOffButton
                            conditions={[row.condition]}
                            label={`Switch off ${row.condition.name}`}
                            onSaved={onSaved}
                          />
                        </span>
                      ) : (
                        <span className="pill off">off</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > COLLAPSED_ROWS && (
            <button
              type="button"
              className="link-button secondary show-all"
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll
                ? `Show only the newest ${COLLAPSED_ROWS}`
                : `Show all ${rows.length} test conditions`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function SwitchOffButton({
  conditions,
  label,
  onSaved,
}: {
  conditions: Condition[];
  label: string;
  onSaved: () => void;
}) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  async function switchOff() {
    setState("saving");
    try {
      for (const condition of conditions) {
        await putCondition({ ...condition, active: false });
      }
      setState("idle");
      onSaved();
    } catch {
      setState("error");
      // Some may have been switched off before the failure; refresh the view.
      if (conditions.length > 1) onSaved();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void switchOff()}
        disabled={state === "saving"}
        aria-label={label}
      >
        {state === "saving" ? "Switching off" : conditions.length > 1 ? label : "Switch off"}
      </button>
      {state === "error" && <span className="bad">Error</span>}
    </>
  );
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatCreated(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
