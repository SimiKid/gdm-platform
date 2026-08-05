import { useMemo, useState } from "react";
import type { Condition, ConditionProgress, SessionSummary } from "@gdm/shared";
import { apiFetch, isTestCondition } from "../api";
import { PilotLinksCard, SessionsTable } from "./Overview";
import { RecruitingTable } from "./Settings";

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
    (session) =>
      session.status === "running" ||
      session.status === "provisioning" ||
      session.status === "waiting",
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

      <TwoBotCard rows={studyRows} onSaved={onSaved} />

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
          <RecruitingTable rows={testRows} onSaved={onSaved} />
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

/**
 * Per-arm toggle for the 2-bot comparison test: Assistant A (rule-based) and
 * Assistant B (rule + LLM) nudge side by side, following the condition's
 * public/private delivery. Pilot tool only — it lives here, away from the
 * recruiting controls, because it must never run for real study sessions.
 */
function TwoBotCard({ rows, onSaved }: { rows: ConditionProgress[]; onSaved: () => void }) {
  const arms = rows.filter(
    (row) => row.condition.config.interventionMode !== "baseline",
  );
  const [error, setError] = useState(false);
  const enabled = arms.filter(
    (row) => row.condition.config.comparisonMode === true,
  );

  async function toggle(condition: Condition, next: boolean) {
    setError(false);
    const res = await apiFetch(`/conditions/${condition.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        condition: {
          ...condition,
          config: { ...condition.config, comparisonMode: next },
        },
      }),
    });
    if (!res.ok) {
      setError(true);
      return;
    }
    onSaved();
  }

  if (arms.length === 0) return null;

  return (
    <section className="section">
      <h2>2-Bot Comparison Test</h2>
      <p className="hint">
        Runs Assistant A (rule-based) and Assistant B (rule + LLM) side by
        side in the same room, following the condition's public/private
        delivery. For piloting the detection arms only:{" "}
        <strong>never for real study sessions</strong>.
      </p>
      {error && <p className="bad">Could not save the toggle. Try again.</p>}
      {enabled.length > 0 && (
        <div className="warnbar">
          ⚠ 2-bot test is on for{" "}
          <strong>{enabled.map((row) => row.condition.name).join(", ")}</strong>
          . Switch it off before recruiting real participants.
        </div>
      )}
      <div className="twobot-list">
        {arms.map(({ condition }) => {
          const on = condition.config.comparisonMode === true;
          return (
            <div className="twobot-row" key={condition.id}>
              <span className="who">
                <strong>{condition.name}</strong>
                <small>
                  {condition.config.interventionMode === "private"
                    ? "🔒 Private delivery (both assistants follow it)"
                    : "📢 Public delivery (both assistants follow it)"}
                </small>
              </span>
              <span className="twobot-state">
                <span className="st">{on ? "on" : "off"}</span>
                <label className="switch danger" title="2-bot test">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => void toggle(condition, e.target.checked)}
                    aria-label={`${condition.name} 2-bot test`}
                  />
                  <span className="knob" />
                </label>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
