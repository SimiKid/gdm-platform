import { useMemo } from "react";
import type { ConditionProgress, SessionSummary } from "@gdm/shared";
import { isTestCondition } from "../api";
import { PilotLinksCard, SessionsTable } from "./Overview";
import { ConditionsTable } from "./Settings";

interface Props {
  rows: ConditionProgress[];
  sessions: SessionSummary[];
  onSaved: () => void;
}

/**
 * One isolated workspace for manual pilot tools and automated E2E residue.
 * The production Overview and Settings views deliberately contain none of it.
 */
export default function Testing({ rows, sessions, onSaved }: Props) {
  const studyRows = useMemo(
    () => rows.filter((row) => !isTestCondition(row.condition.id)),
    [rows],
  );
  const testRows = useMemo(
    () => rows.filter((row) => isTestCondition(row.condition.id)),
    [rows],
  );
  const testSessions = useMemo(
    () => sessions.filter((session) => isTestCondition(session.conditionId)),
    [sessions],
  );
  const activeTestConditions = testRows.filter(
    (row) => row.condition.active,
  ).length;
  const openTestSessions = testSessions.filter(
    (session) => session.status === "running" || session.status === "waiting",
  ).length;

  return (
    <>
      <section className="section">
        <h2>Testing Workspace</h2>
        <p className="hint">
          Manual pilot links and automated end-to-end data are kept here so
          they cannot be confused with live study conditions or sessions.
        </p>
        {activeTestConditions > 0 && (
          <p className="bad">
            {activeTestConditions} test{" "}
            {activeTestConditions === 1 ? "condition is" : "conditions are"}{" "}
            still active. Switch them off to prevent real participants from
            being assigned to a test session.
          </p>
        )}
        {openTestSessions > 0 && (
          <p className="bad">
            {openTestSessions} E2E{" "}
            {openTestSessions === 1 ? "session is" : "sessions are"} still
            open.
          </p>
        )}
      </section>

      <PilotLinksCard rows={studyRows} />

      <section className="section">
        <h2>E2E Test Conditions</h2>
        <p className="hint">
          Every automated run creates a temporary condition. It should be
          inactive after the run; retained rows remain available for debugging.
        </p>
        {testRows.length === 0 ? (
          <p className="empty">No E2E test conditions yet.</p>
        ) : (
          <ConditionsTable rows={testRows} onSaved={onSaved} />
        )}
      </section>

      <SessionsTable
        sessions={testSessions}
        title="E2E Test Sessions"
        emptyMessage="No E2E test sessions yet."
        label="E2E test sessions"
      />
    </>
  );
}
