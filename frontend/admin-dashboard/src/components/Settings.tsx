import { useEffect, useMemo, useRef, useState } from "react";
import type { Condition, ConditionProgress, StudySettings } from "@gdm/shared";
import { apiFetch, isTestCondition } from "../api";

interface Props {
  rows: ConditionProgress[];
  /** Re-fetch dashboard data after a successful save. */
  onSaved: () => void;
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Settings view, split by how often a researcher touches things:
 *
 *  1. Recruiting — the daily controls (arm on/off, goal, progress). Study
 *     design (delivery × detection) is shown as read-only badges.
 *  2. Session & Bot Parameters — ONE shared form applied to all study arms.
 *     A between-subjects design needs identical parameters everywhere, so
 *     arms deviating from the shared values surface as a drift warning
 *     instead of being silently editable per row.
 *  3. Compensation link.
 *
 * The 2-bot comparison toggle lives in the Testing view — it is a pilot tool
 * and must not sit next to the daily recruiting controls.
 */
export default function Settings({ rows, onSaved }: Props) {
  const studyRows = rows.filter((row) => !isTestCondition(row.condition.id));

  return (
    <>
      <section className="section">
        <h2>Recruiting</h2>
        <p className="hint">
          Which arms accept participants, and how many groups each still
          needs. A condition stops recruiting automatically at its goal.
          Everything else about an arm is fixed study design — shown, not
          editable.
        </p>
        <RecruitingTable rows={studyRows} onSaved={onSaved} />
      </section>
      <SharedParamsCard rows={studyRows} onSaved={onSaved} />
      <CompensationCard />
    </>
  );
}

async function putCondition(condition: Condition): Promise<Condition> {
  const res = await apiFetch(`/conditions/${condition.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ condition }),
  });
  if (!res.ok) throw new Error(`Save failed (${res.status})`);
  return (await res.json()) as Condition;
}

/* ── Recruiting ─────────────────────────────────────── */

const DELIVERY_LABELS: Record<string, string> = {
  baseline: "No nudges",
  public: "📢 Public",
  private: "🔒 Private",
};

const DETECTION_LABELS: Record<"off" | "active", string> = {
  off: "Rule-based",
  active: "Rule + LLM",
};

function ArmBadges({ condition }: { condition: Condition }) {
  const mode = condition.config.interventionMode;
  const llm = condition.config.llmMode ?? "off";
  return (
    <span className="arm-badges">
      <span className="arm">{DELIVERY_LABELS[mode] ?? mode}</span>
      {mode !== "baseline" && (
        <span className={llm === "active" ? "arm llm" : "arm"}>
          {DETECTION_LABELS[llm]}
        </span>
      )}
    </span>
  );
}

/** Also used by the Testing view to switch off E2E residue conditions. */
export function RecruitingTable({ rows, onSaved }: Props) {
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
            <RecruitingRow key={row.condition.id} row={row} onSaved={onSaved} />
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
  const pct =
    condition.goal > 0
      ? Math.min(100, (row.completed / condition.goal) * 100)
      : 0;

  return (
    <tr>
      <td>
        <strong>{condition.name}</strong>
        <ArmBadges condition={condition} />
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
        <div className="bar">
          <span style={{ width: `${pct}%` }} />
        </div>
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

/* ── Shared session & bot parameters ────────────────── */

/** The six tunables, in the units researchers edit them in. */
interface ParamValues {
  durationMinutes: number;
  groupSize: number;
  warmupMinutes: number;
  wrapupSeconds: number;
  windowSeconds: number;
  triggerPercent: number;
}

const PARAM_FIELDS: Array<{
  key: keyof ParamValues;
  label: string;
  unit: string;
  min: number;
  why: string;
}> = [
  {
    key: "durationMinutes",
    label: "Discussion time",
    unit: "minutes",
    min: 1,
    why: "Length of the group chat; the participant timer counts this down.",
  },
  {
    key: "groupSize",
    label: "Group size",
    unit: "people",
    min: 2,
    why: "Participants per session. The waiting room fills to this number.",
  },
  {
    key: "warmupMinutes",
    label: "Warm-up",
    unit: "minutes",
    min: 0,
    why: "Arrival phase: nobody is counted or nudged until it ends.",
  },
  {
    key: "wrapupSeconds",
    label: "Wrap-up",
    unit: "seconds",
    min: 0,
    why: "Final stretch: no nudges fire, participant timer turns red.",
  },
  {
    key: "windowSeconds",
    label: "Contribution window",
    unit: "seconds",
    min: 1,
    why: "The bot evaluates the split — and can nudge once — at the end of every window.",
  },
  {
    key: "triggerPercent",
    label: "Trigger at",
    unit: "% dominance",
    min: 1,
    why: "A member crossing this share of the conversation gets nudged. Protocol: 40.",
  },
];

const PARAM_LABEL = Object.fromEntries(
  PARAM_FIELDS.map((field) => [field.key, field.label]),
) as Record<keyof ParamValues, string>;

function valuesOf(condition: Condition): ParamValues {
  return {
    durationMinutes: condition.durationMinutes,
    groupSize: condition.groupSize,
    warmupMinutes: condition.config.protectedStartMinutes,
    wrapupSeconds: Math.round(condition.config.protectedEndMinutes * 60),
    windowSeconds: Math.round(condition.config.contributionWindowMinutes * 60),
    triggerPercent: Math.round(condition.config.contributionThreshold * 100),
  };
}

function withValues(condition: Condition, values: ParamValues): Condition {
  return {
    ...condition,
    durationMinutes: values.durationMinutes,
    groupSize: values.groupSize,
    config: {
      ...condition.config,
      protectedStartMinutes: values.warmupMinutes,
      protectedEndMinutes: values.wrapupSeconds / 60,
      contributionWindowMinutes: values.windowSeconds / 60,
      contributionThreshold: values.triggerPercent / 100,
    },
  };
}

/** Per field, the value most arms share — the baseline drift is measured against. */
function majorityValues(rows: ConditionProgress[]): ParamValues | null {
  if (rows.length === 0) return null;
  const all = rows.map((row) => valuesOf(row.condition));
  const result = {} as ParamValues;
  for (const field of PARAM_FIELDS) {
    const counts = new Map<number, number>();
    for (const values of all) {
      const value = values[field.key];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best = all[0][field.key];
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    result[field.key] = best;
  }
  return result;
}

function formatValue(key: keyof ParamValues, value: number): string {
  const unit = PARAM_FIELDS.find((field) => field.key === key)!.unit;
  if (unit === "minutes") return `${value} min`;
  if (unit === "seconds") return `${value} s`;
  if (unit === "% dominance") return `${value}%`;
  return String(value);
}

function SharedParamsCard({ rows, onSaved }: Props) {
  const shared = useMemo(() => majorityValues(rows), [rows]);
  const [draft, setDraft] = useState<ParamValues | null>(null);
  const [dirty, setDirty] = useState(false);
  const [state, setState] = useState<SaveState>("idle");

  // Track the polled server state; adopt it while there are no unsaved edits.
  useEffect(() => {
    if (!dirty && shared) setDraft(shared);
  }, [shared, dirty]);

  // Arms whose stored values differ from the shared baseline.
  const drifted = useMemo(() => {
    if (!shared) return [];
    return rows
      .map((row) => {
        const values = valuesOf(row.condition);
        const fields = PARAM_FIELDS.filter(
          (field) => values[field.key] !== shared[field.key],
        ).map((field) => field.key);
        return { row, values, fields };
      })
      .filter((entry) => entry.fields.length > 0);
  }, [rows, shared]);

  async function saveAll(targets: ConditionProgress[]) {
    if (!draft) return;
    setState("saving");
    try {
      for (const target of targets) {
        await putCondition(withValues(target.condition, draft));
      }
      setDirty(false);
      setState("saved");
      onSaved();
    } catch {
      setState("error");
    }
  }

  if (!shared || !draft) return null;

  return (
    <section className="section">
      <h2>Session &amp; Bot Parameters</h2>
      <p className="hint">
        One set of values for <strong>all study arms</strong> — in a
        between-subjects design these must be identical everywhere. Saving
        applies to every study condition; already running sessions keep their
        settings.
      </p>

      <div className="param-grid">
        {PARAM_FIELDS.map((field) => (
          <div className="param" key={field.key}>
            <label htmlFor={`param-${field.key}`}>
              {field.label} <span className="unit">{field.unit}</span>
            </label>
            <input
              id={`param-${field.key}`}
              type="number"
              min={field.min}
              value={Number.isFinite(draft[field.key]) ? draft[field.key] : 0}
              onChange={(e) => {
                setDraft({ ...draft, [field.key]: Number(e.target.value) });
                setDirty(true);
                setState("idle");
              }}
            />
            <span className="why">{field.why}</span>
          </div>
        ))}
      </div>

      {drifted.length === 0 ? (
        <div className="allgood">
          ✓ All {rows.length} arms share these values.
        </div>
      ) : (
        drifted.map(({ row, values, fields }) => (
          <div className="drift" key={row.condition.id}>
            <span>
              ⚠ <strong>{row.condition.name}</strong> differs:{" "}
              {fields
                .map(
                  (key) =>
                    `${PARAM_LABEL[key]} is ${formatValue(key, values[key])} there, shared value is ${formatValue(key, shared[key])}`,
                )
                .join("; ")}
              . Arms must match for a valid comparison.
            </span>
            <button type="button" onClick={() => void saveAll([row])}>
              Align to shared
            </button>
          </div>
        ))
      )}

      <div className="param-foot">
        <button
          type="button"
          onClick={() => void saveAll(rows)}
          disabled={state === "saving" || !dirty}
        >
          {state === "saving" ? "Saving" : "Apply to all study arms"}
        </button>
        {state === "saved" && (
          <span className="ok">Saved — applies to newly formed sessions</span>
        )}
        {state === "error" && <span className="bad">Error — not all arms saved</span>}
        {state === "idle" && !dirty && (
          <span className="muted">Edit a value to enable saving.</span>
        )}
      </div>
    </section>
  );
}

/* ── Compensation link ──────────────────────────────── */

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
