import { useEffect, useRef, useState } from "react";
import type { Condition, ConditionProgress, StudySettings } from "@gdm/shared";
import { apiFetch, isTestCondition } from "../api";

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
    <>
      <CompensationCard />
      <ConditionsCard rows={rows} onSaved={onSaved} />
    </>
  );
}

/**
 * Where the debriefing page's "Claim compensation" button sends participants
 * (payment / Prolific completion link). Stored study-wide on the backend.
 */
function CompensationCard() {
  const [url, setUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [state, setState] = useState<SaveState>("idle");

  useEffect(() => {
    void apiFetch("/settings").then(async (res) => {
      if (!res.ok) return;
      const settings = (await res.json()) as StudySettings;
      setUrl(settings.compensationUrl);
      setSaved(settings.compensationUrl);
      setLoaded(true);
    });
  }, []);

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { compensationUrl: url.trim() } }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const settings = (await res.json()) as StudySettings;
      setUrl(settings.compensationUrl);
      setSaved(settings.compensationUrl);
      setState("saved");
    } catch {
      setState("error");
    }
  }

  const dirty = url.trim() !== saved;

  return (
    <section className="section">
      <h2>Compensation Link</h2>
      <p className="hint">
        Participants land on this link when they press “Claim compensation” on
        the final debriefing page (e.g. your payment form or Prolific
        completion URL). Leave empty to use the app's build-time default.
      </p>
      <div className="copy-row">
        <input
          type="url"
          placeholder="https://…"
          value={url}
          disabled={!loaded}
          onChange={(e) => {
            setUrl(e.target.value);
            setState("idle");
          }}
          aria-label="Compensation link"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={state === "saving" || !loaded || !dirty}
        >
          {state === "saving" ? "Saving" : "Save"}
        </button>
        {state === "saved" && <span className="ok">Saved</span>}
        {state === "error" && <span className="bad">Error</span>}
      </div>
    </section>
  );
}

function ConditionsCard({ rows, onSaved }: Props) {
  const studyRows = rows.filter((row) => !isTestCondition(row.condition.id));

  return (
    <section className="section">
      <h2>Conditions</h2>
      <p className="hint">
        A condition stops recruiting automatically once it reaches its goal or
        when you switch it off. Changes apply to newly formed sessions —
        already running ones keep their settings.
      </p>
      <ConditionsTable rows={studyRows} onSaved={onSaved} />
    </section>
  );
}

export function ConditionsTable({ rows, onSaved }: Props) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap" aria-label="Condition settings">
      <table>
        <thead>
          <tr>
            <th>Condition</th>
            <th>Semantic analysis</th>
            <th>Bot mode</th>
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
  );
}

function ConditionRow({ row, onSaved }: { row: ConditionProgress; onSaved: () => void }) {
  const [draft, setDraft] = useState<Condition>(row.condition);
  const [state, setState] = useState<SaveState>("idle");

  // The dashboard polls every few seconds, so fresh `row.condition` objects
  // keep arriving. Only adopt them while the draft still matches the previous
  // server state — unsaved edits must survive the poll (issue #26).
  const serverRef = useRef(row.condition);
  useEffect(() => {
    const prevServer = serverRef.current;
    serverRef.current = row.condition;
    setDraft((current) =>
      JSON.stringify(current) === JSON.stringify(prevServer)
        ? row.condition
        : current,
    );
  }, [row.condition]);

  function patch(next: Partial<Condition>) {
    setDraft((current) => ({ ...current, ...next }));
    setState("idle");
  }

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch(`/conditions/${draft.id}`, {
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
        <select
          value={draft.config.llmMode ?? "off"}
          onChange={(e) =>
            patch({
              config: {
                ...draft.config,
                llmMode: e.target.value as "off" | "shadow",
              },
            })
          }
          aria-label={`${draft.name} semantic analysis`}
        >
          <option value="off">off</option>
          <option value="shadow">shadow</option>
        </select>
      </td>
      <td>
        {/* Read-only: which nudge behavior the bot runs (baseline = none).
            Tuning stays backend-only by design. */}
        <span className="bot-mode">{draft.config.interventionMode}</span>
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
