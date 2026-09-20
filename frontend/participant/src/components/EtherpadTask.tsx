import { useCallback, useEffect, useRef, useState } from "react";
import type { PadPhase, StudyPad } from "@gdm/shared";
import { MOON_SURVIVAL, MOON_SURVIVAL_BRIEFING } from "@gdm/shared";
import { workspaceClient } from "../study/workspaceClient";
import { TOKEN_STORAGE_KEY } from "../study/progress";
import StudyCountdown from "./StudyCountdown";

interface Props { phase: PadPhase; sessionId?: string; onComplete?: (pad: StudyPad) => void }
export default function EtherpadTask({ phase, sessionId, onComplete }: Props) {
  const [pad, setPad] = useState<StudyPad | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const completed = useRef(false);
  const callback = useRef(onComplete);
  callback.current = onComplete;
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";

  useEffect(() => {
    let cancelled = false;
    setError("");
    void workspaceClient.pad(token, phase, sessionId).then(value => {
      if (cancelled) return;
      setPad(value);
      if (value.state === "captured" && !completed.current) { completed.current = true; callback.current?.(value); }
    }).catch(e => { if (!cancelled) setError(String(e.message)); });
    return () => { cancelled = true; };
  }, [token, phase, sessionId, attempt]);

  const finish = useCallback(async () => {
    if (!pad || inFlight.current || completed.current) return;
    inFlight.current = true; setSaving(true); setError("");
    try {
      if (Date.now() < Date.parse(pad.deadline)) {
        await flushEditor(frame.current);
      }
      const captured = await workspaceClient.finish(token, pad.id);
      setPad(captured); completed.current = true; callback.current?.(captured);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save your writing. Please retry."); }
    finally { inFlight.current = false; setSaving(false); }
  }, [pad, token]);

  return (
    <section className="etherpad-task">
      {pad && phase !== "group" && pad.state !== "captured" && <StudyCountdown deadline={Date.parse(pad.deadline)} label="Writing time remaining" onExpire={() => void finish()} />}
      <div className="study-card">
        <h2>{phase === "group" ? "Group workspace" : phase === "entry" ? "Your initial response" : "Your final response"}</h2>
        <p>{phase === "group" ? "Use this shared space to record your group's decision. Discuss ideas in the chat." : "Write your own response to the Moon Survival task. Explain which items matter most and why. This pad is private to you."} Maximum 1,000 characters, including spaces and line breaks.</p>
        <details open={phase === "entry"}><summary>Moon Survival task and available items</summary><div dangerouslySetInnerHTML={{ __html: MOON_SURVIVAL_BRIEFING.html }} /><ul>{MOON_SURVIVAL.items.map(item => <li key={item.id}>{item.label}</li>)}</ul></details>
        {!pad && !error && <p role="status">Opening your writing workspace…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {error && <button className="btn btn-primary" disabled={saving} onClick={() => pad ? void finish() : setAttempt(n => n + 1)}>Try again</button>}
        {pad?.embedUrl && <iframe ref={frame} className="etherpad-frame" src={pad.embedUrl} title={`${phase} writing workspace`} referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin" />}
        {pad?.state === "captured" && <pre className="etherpad-text">{pad.text || "No text entered."}</pre>}
        {pad && phase !== "group" && pad.state !== "captured" && <button className="btn btn-primary" disabled={saving} onClick={() => void finish()}>{saving ? "Saving your response…" : "Submit my response"}</button>}
      </div>
    </section>
  );
}

function flushEditor(frame: HTMLIFrameElement | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { cleanup(); reject(new Error("Your editor has not confirmed saving. Check your connection and try again.")); }, 6500);
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", receive); };
    const receive = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame?.contentWindow || event.data?.requestId !== requestId) return;
      if (event.data.type === "gdm-flushed") { cleanup(); resolve(); }
      if (event.data.type === "gdm-flush-failed") { cleanup(); reject(new Error("Your latest edits are still syncing. Please retry.")); }
    };
    window.addEventListener("message", receive);
    frame?.contentWindow?.postMessage({ type: "gdm-flush", requestId }, location.origin);
  });
}
