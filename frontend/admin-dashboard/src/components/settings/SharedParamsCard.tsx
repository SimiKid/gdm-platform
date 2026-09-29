import { useEffect, useMemo, useState } from "react";
import type { Condition, ConditionProgress } from "@gdm/shared";
import { putCondition } from "../../api";
import type { ArmRowsProps, SaveState } from "./types";

/** The six tunables, in the units researchers edit them in. */
interface ParamValues {
  durationMinutes: number;
  groupSize: number;
  warmupSeconds: number;
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
    key: "warmupSeconds",
    label: "Warm-up",
    unit: "seconds",
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
    why: "The bot evaluates the split, and can nudge once, at the end of every window.",
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
    warmupSeconds: Math.round(condition.config.protectedStartMinutes * 60),
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
      protectedStartMinutes: values.warmupSeconds / 60,
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

/** One shared form for the session and bot parameters of every study arm. */
export default function SharedParamsCard({ rows, onSaved }: ArmRowsProps) {
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
        One set of values for <strong>all study arms</strong>: in a
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
          <span className="ok">Saved. Applies to newly formed sessions</span>
        )}
        {state === "error" && <span className="bad">Error: not all arms saved</span>}
        {state === "idle" && !dirty && (
          <span className="muted">Edit a value to enable saving.</span>
        )}
      </div>
    </section>
  );
}
