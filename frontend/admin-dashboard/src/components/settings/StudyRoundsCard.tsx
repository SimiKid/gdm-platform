import { useState } from "react";
import type { RoundsResponse, StudyRound } from "@gdm/shared";
import { apiFetch } from "../../api";
import { useTimeout } from "../../use-timeout";
import type { SaveState } from "./types";

/**
 * The study runs in numbered rounds. Starting a new one restarts every
 * arm's progress at 0/goal (per-round counting on the backend) and aborts
 * open lobbies — the researcher then adjusts the shared parameters below
 * if the new round uses different settings.
 */
export default function StudyRoundsCard({
  rounds,
  lobbyCount,
  onSaved,
}: {
  rounds: RoundsResponse | null;
  lobbyCount: number;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<SaveState>("idle");
  const later = useTimeout();

  if (!rounds) return null;
  const nextNumber = rounds.currentRound + 1;
  const current = rounds.rounds.find(
    (round) => round.number === rounds.currentRound,
  );

  async function start() {
    setState("saving");
    try {
      const res = await apiFetch("/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(`Start failed (${res.status})`);
      setState("saved");
      setConfirming(false);
      setLabel("");
      onSaved();
      later(() => setState("idle"), 1500);
    } catch {
      setState("error");
    }
  }

  return (
    <section className="section">
      <h2>Study Rounds</h2>
      <p className="hint">
        You are collecting data for{" "}
        <strong>
          Round {rounds.currentRound}
          {current?.label ? ` (${current.label})` : ""}
        </strong>
        {current ? ` (since ${new Date(current.startedAt).toLocaleDateString()})` : ""}.
        Starting a new round restarts every arm&apos;s progress at 0 / goal;
        recruiting switches, goals and parameters keep their values. Open
        waiting-room lobbies are aborted so groups never mix rounds; running
        sessions finish in their round. To run the next round with different
        settings, start it here, then edit the Session &amp; Bot Parameters
        below.
      </p>
      {rounds.rounds.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Round</th>
                <th>Label</th>
                <th>Started</th>
                <th>Ended</th>
                <th className="num">Sessions</th>
                <th className="num">Completed</th>
              </tr>
            </thead>
            <tbody>
              {rounds.rounds.map((round) => (
                <RoundRow
                  key={round.number}
                  round={round}
                  isCurrent={round.number === rounds.currentRound}
                  onSaved={onSaved}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirming ? (
        <div className="copy-row">
          <span className="pilot-name">
            Start Round {nextNumber}
            {lobbyCount > 0
              ? ` and abort ${lobbyCount} waiting ${lobbyCount === 1 ? "lobby" : "lobbies"}`
              : ""}
            ?
          </span>
          <button type="button" onClick={() => void start()} disabled={state === "saving"}>
            {state === "saving" ? "Starting…" : "Confirm"}
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="copy-row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`Label for Round ${nextNumber} (optional, e.g. "threshold 35%")`}
            aria-label={`Label for Round ${nextNumber}`}
          />
          <button type="button" onClick={() => setConfirming(true)}>
            Start Round {nextNumber}
          </button>
        </div>
      )}
      {state === "error" && <p className="error">Could not start the round.</p>}
      {state === "saved" && !confirming && <p className="hint">Round started ✓</p>}
    </section>
  );
}

function RoundRow({
  round,
  isCurrent,
  onSaved,
}: {
  round: StudyRound;
  isCurrent: boolean;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(round.label);
  const [state, setState] = useState<SaveState>("idle");
  const later = useTimeout();
  const dirty = label.trim() !== round.label;

  async function save() {
    setState("saving");
    try {
      const res = await apiFetch(`/rounds/${round.number}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      setState("saved");
      onSaved();
      later(() => setState("idle"), 1500);
    } catch {
      setState("error");
    }
  }

  return (
    <tr>
      <td>
        <strong>Round {round.number}</strong>
        {isCurrent && <span className="status running"> current</span>}
      </td>
      <td>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="no label"
          aria-label={`Label for round ${round.number}`}
        />
        {dirty && (
          <button type="button" onClick={() => void save()} disabled={state === "saving"}>
            {state === "saving" ? "Saving…" : state === "error" ? "Retry" : "Save"}
          </button>
        )}
        {state === "saved" && !dirty && <span className="hint"> ✓</span>}
      </td>
      <td>{new Date(round.startedAt).toLocaleDateString()}</td>
      <td>
        {round.endedAt
          ? new Date(round.endedAt).toLocaleDateString()
          : "still open"}
      </td>
      <td className="num">{round.sessionCount}</td>
      <td className="num">{round.completedCount}</td>
    </tr>
  );
}
