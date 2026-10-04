import { useEffect, useRef, useState } from "react";
import type { Condition, ConditionProgress } from "@gdm/shared";
import { putCondition } from "../../api";
import ArmBadge from "../ArmBadge";
import ProgressBar from "../ProgressBar";
import type { ArmRowsProps, SaveState } from "./types";

/** Per arm: recruiting switch, goal and progress toward it. */
export default function RecruitingTable({ rows, onSaved }: ArmRowsProps) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap" aria-label="Recruiting">
      <table>
        <thead>
          <tr>
            <th>Condition</th>
            <th>Recruiting</th>
            <th className="num">Goal</th>
            <th>Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <RecruitingRow
              key={row.condition.id}
              row={row}
              onSaved={onSaved}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecruitingRow({
  row,
  onSaved,
}: {
  row: ConditionProgress;
  onSaved: () => void;
}) {
  const [goal, setGoal] = useState(row.condition.goal);
  const [state, setState] = useState<SaveState>("idle");

  // The dashboard polls every few seconds. Adopt fresh server goals only
  // while the field is not dirty, so unsaved edits survive the poll.
  const serverGoal = useRef(row.condition.goal);
  useEffect(() => {
    const previous = serverGoal.current;
    serverGoal.current = row.condition.goal;
    setGoal((current) => (current === previous ? row.condition.goal : current));
  }, [row.condition.goal]);

  async function save(next: Condition) {
    setState("saving");
    try {
      await putCondition(next);
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  const condition = row.condition;
  const goalReached = row.completed >= condition.goal && condition.goal > 0;
  const dirty = goal !== condition.goal;

  return (
    <tr>
      <td>
        <strong>{condition.name}</strong>
        <ArmBadge condition={condition} />
      </td>
      <td>
        <label className="switch" title="Toggle recruiting">
          <input
            type="checkbox"
            checked={condition.active}
            onChange={(e) =>
              void save({ ...condition, active: e.target.checked })
            }
            aria-label={`${condition.name} recruiting`}
          />
          <span className="knob" />
        </label>
        <div className="progress-label">
          {goalReached ? (
            <span className="pill done">goal reached</span>
          ) : condition.active ? (
            <span className="pill on">recruiting</span>
          ) : (
            <span className="pill off">off</span>
          )}
        </div>
      </td>
      <td className="num">
        <input
          className="goal-input"
          type="number"
          min={0}
          value={Number.isFinite(goal) ? goal : 0}
          onChange={(e) => {
            setGoal(Number(e.target.value));
            setState("idle");
          }}
          aria-label={`${condition.name} goal`}
        />
      </td>
      <td>
        <ProgressBar completed={row.completed} goal={condition.goal} />
        <div className="progress-label">
          {row.completed} / {condition.goal} ·{" "}
          {Math.max(0, condition.goal - row.completed)} remaining
        </div>
      </td>
      <td>
        <button
          type="button"
          onClick={() => void save({ ...condition, goal })}
          disabled={state === "saving" || !dirty}
        >
          {state === "saving" ? "Saving" : "Save"}
        </button>
        {state === "saved" && <span className="ok">Saved</span>}
        {state === "error" && <span className="bad">Error</span>}
      </td>
    </tr>
  );
}
