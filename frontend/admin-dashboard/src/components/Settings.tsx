import { useEffect, useState } from "react";
import type { Condition, ConditionProgress } from "@gdm/shared";
import { API_BASE } from "../App";

interface Props {
  rows: ConditionProgress[];
  /** Re-fetch dashboard data after a successful save. */
  onSaved: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Condition settings (wireframe: Settings — Active / Goal / Time / # People
 * per condition). The four 2×2 arms are fixed; bot tuning stays backend-only.
 */
export default function Settings({ rows, onSaved }: Props) {
  return (
    <section className="section">
      <h2>Conditions</h2>
      <p className="hint">
        A condition stops recruiting automatically once it reaches its goal or
        when you switch it off. Changes apply to newly formed sessions —
        already running ones keep their settings.
      </p>
      <div className="table-wrap" aria-label="Condition settings">
        <table>
          <thead>
            <tr>
              <th>Condition</th>
              <th>Active</th>
              <th>Goal</th>
              <th>Discussion time (min)</th>
              <th># People</th>
              <th>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ConditionRow key={row.condition.id} row={row} onSaved={onSaved} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ConditionRow({ row, onSaved }: { row: ConditionProgress; onSaved: () => void }) {
  const [draft, setDraft] = useState<Condition>(row.condition);
  const [state, setState] = useState<SaveState>("idle");

  // Adopt fresh server data unless the researcher is mid-edit.
  useEffect(() => {
    if (state === "idle") setDraft(row.condition);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.condition]);

  function patch(next: Partial<Condition>) {
    setDraft((current) => ({ ...current, ...next }));
    setState("idle");
  }

  async function save() {
    setState("saving");
    try {
      const res = await fetch(`${API_BASE}/conditions/${draft.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ condition: draft }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      setDraft((await res.json()) as Condition);
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(row.condition);
  const pct = draft.goal > 0 ? Math.min(100, (row.completed / draft.goal) * 100) : 0;

  return (
    <tr>
      <td>
        <strong>{draft.name}</strong>
        <span className="muted">{draft.id}</span>
      </td>
      <td>
        <label className="switch">
          <input
            type="checkbox"
            checked={draft.active}
            onChange={(e) => patch({ active: e.target.checked })}
            aria-label={`${draft.name} active`}
          />
          <span>{draft.active ? "on" : "off"}</span>
        </label>
      </td>
      <td className="num">
        <NumberInput value={draft.goal} min={0} onChange={(goal) => patch({ goal })} />
      </td>
      <td className="num">
        <NumberInput
          value={draft.durationMinutes}
          min={1}
          onChange={(durationMinutes) => patch({ durationMinutes })}
        />
      </td>
      <td className="num">
        <NumberInput
          value={draft.groupSize}
          min={2}
          onChange={(groupSize) => patch({ groupSize })}
        />
      </td>
      <td>
        <div className="progress-label">
          {row.completed} / {draft.goal}
        </div>
        <div className="bar">
          <span style={{ width: `${pct}%` }} />
        </div>
      </td>
      <td>
        <button
          type="button"
          onClick={() => void save()}
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

function NumberInput({
  value,
  onChange,
  min,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
