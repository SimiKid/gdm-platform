import type { EtherpadStatus } from "@gdm/shared";

const WORKSPACE_STATE: Record<EtherpadStatus["state"], { label: string; tone: string }> = {
  stopped: { label: "stopped", tone: "off" },
  starting: { label: "starting…", tone: "busy" },
  ready: { label: "ready", tone: "ok" },
  draining: { label: "draining", tone: "warn" },
  stopping: { label: "stopping…", tone: "busy" },
  error: { label: "error", tone: "bad" },
};

/** Global switch for the Etherpad writing mode and the editor server's state. */
export default function WorkspaceCard({
  status,
  onToggle,
}: {
  status: EtherpadStatus | null;
  onToggle: (enabled: boolean) => void;
}) {
  const state = status ? WORKSPACE_STATE[status.state] : { label: "loading…", tone: "off" };
  return (
    <section className="section">
      <h2>Etherpad workspace</h2>
      <p className="hint">
        When enabled, new participants write in private entry and exit pads and
        a shared group pad (1,000 characters each) instead of using the shared
        ranking. Ranking scores are not calculated for these sessions.
      </p>
      <div className="workspace-row">
        <label className="switch" title="Toggle Etherpad">
          <input
            type="checkbox"
            role="switch"
            aria-label="Enable Etherpad"
            checked={status?.enabled ?? false}
            disabled={!status}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="knob" />
        </label>
        <div className="workspace-copy">
          <strong>Enable Etherpad</strong>
          <span className="hint">
            Each participant keeps the mode they started with. The server starts
            automatically when you enable it; switching off preserves their work,
            then stops the editor.
          </span>
        </div>
        <span className={`status workspace-state ${state.tone}`} role="status">
          Server {state.label}
        </span>
      </div>
      {status?.state === "draining" && (
        <p className="workspace-warning">
          New participants use the ranking again. Etherpad stops after the{" "}
          {status.activeParticipants} existing writing participant(s) finish or
          their time expires.
        </p>
      )}
      {status?.state === "error" && (
        <div className="error error-row">
          <span>{status.error}</span>
          <button type="button" onClick={() => onToggle(status.enabled)}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
