import { useEffect, useRef, useState } from "react";
import type { StudySettings } from "@gdm/shared";
import { apiFetch } from "../../api";
import type { SaveState } from "./types";

const EMPTY_PATHS: StudySettings = {
  compensationUrl: "",
  noConsentUrl: "",
  ineligibleUrl: "",
  withdrawalUrl: "",
  unmatchedUrl: "",
  technicalFailureUrl: "",
};

const PROLIFIC_PATHS: Array<{
  key: keyof StudySettings;
  label: string;
  help: string;
}> = [
  {
    key: "compensationUrl",
    label: "Full completion",
    help: "Normal Prolific completion URL shown after the exit survey.",
  },
  {
    key: "noConsentUrl",
    label: "Consent declined",
    help: "Return/no-payment path for someone who does not consent.",
  },
  {
    key: "ineligibleUrl",
    label: "Ineligible",
    help: "Screen-out or return path for an eligibility failure.",
  },
  {
    key: "withdrawalUrl",
    label: "Voluntary withdrawal",
    help: "Return path after the participant chooses to stop.",
  },
  {
    key: "unmatchedUrl",
    label: "Group not formed",
    help: "Return path after the waiting-room deadline; partial payment is separate.",
  },
  {
    key: "technicalFailureUrl",
    label: "Technical/group failure",
    help: "Return path when a started or provisioning group cannot continue.",
  },
];

/** Prolific completion and early-exit return URLs. */
export default function CompensationCard() {
  const [paths, setPaths] = useState<StudySettings>(EMPTY_PATHS);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<StudySettings>(EMPTY_PATHS);
  const [state, setState] = useState<SaveState>("idle");
  const loadRequest = useRef<AbortController | null>(null);

  // The inputs stay disabled until the stored paths arrive, so a failed load
  // must say so (and offer a retry) instead of leaving a dead form.
  function load() {
    loadRequest.current?.abort();
    const request = new AbortController();
    loadRequest.current = request;
    setLoadError(null);
    apiFetch("/settings", { signal: request.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the saved paths (${res.status}).`);
        const settings = (await res.json()) as StudySettings;
        if (request.signal.aborted) return;
        setPaths(settings);
        setSaved(settings);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (request.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : "Could not load the saved paths.");
      });
  }

  useEffect(() => {
    load();
    return () => loadRequest.current?.abort();
  }, []);

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: Object.fromEntries(
            PROLIFIC_PATHS.map(({ key }) => [key, paths[key].trim()]),
          ),
        }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      const settings = (await res.json()) as StudySettings;
      setPaths(settings);
      setSaved(settings);
      setState("saved");
    } catch {
      setState("error");
    }
  }

  const dirty = PROLIFIC_PATHS.some(
    ({ key }) => paths[key].trim() !== saved[key],
  );

  return (
    <section className="section">
      <h2>Prolific completion and exit paths</h2>
      <p className="hint">
        These URLs are configured in Prolific. The app records the outcome
        first, then offers the matching return link. Empty early-exit URLs
        intentionally stop the participant and ask them to contact the
        researcher instead of guessing a completion code.
      </p>
      {loadError && (
        <div className="error error-row" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={load}>
            Retry
          </button>
        </div>
      )}
      <div className="prolific-paths">
        {PROLIFIC_PATHS.map((field) => (
          <label key={field.key} htmlFor={`prolific-${field.key}`}>
            <strong>{field.label}</strong>
            <span className="hint">{field.help}</span>
            <input
              id={`prolific-${field.key}`}
              type="url"
              placeholder="https://…"
              value={paths[field.key]}
              disabled={!loaded}
              onChange={(event) => {
                setPaths({ ...paths, [field.key]: event.target.value });
                setState("idle");
              }}
            />
          </label>
        ))}
      </div>
      <div className="param-foot">
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
