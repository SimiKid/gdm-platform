import { useState } from "react";
import type { ParticipationOutcomeRecord } from "@gdm/shared";
import { apiFetch } from "../api";

export default function ProlificOutcomes({
  outcomes,
  onChanged,
}: {
  outcomes: ParticipationOutcomeRecord[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  async function act(id: string, action: string) {
    if (
      action === "request-return" &&
      !window.confirm(
        "Ask this participant to return their Prolific submission?",
      )
    ) {
      return;
    }
    if (
      action === "pay-bonus" &&
      !window.confirm(
        "Pay this prepared Prolific bonus? This cannot be undone.",
      )
    ) {
      return;
    }
    setBusy(`${id}:${action}`);
    setError("");
    try {
      const res = await apiFetch(
        `/admin/prolific/outcomes/${id}/actions/${action}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Action failed (${res.status})`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="section">
      <h2>Prolific outcomes and compensation</h2>
      <p className="hint">
        Full completion uses the normal completion path. Returns and partial
        payments are intentionally separate, auditable actions.
      </p>
      {error && <p className="bad">{error}</p>}
      {outcomes.length === 0 ? (
        <p className="hint">No Prolific arrivals yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Submission</th>
                <th>Stage / outcome</th>
                <th>Elapsed</th>
                <th>Compensation</th>
                <th>Prolific action</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {outcomes.map((row) => (
                <tr key={row.id}>
                  <td title={row.sessionId}>{row.sessionId.slice(0, 8)}</td>
                  <td>
                    <strong>{row.outcome ?? row.stage}</strong>
                    {row.outcomeReason && (
                      <div className="hint">{row.outcomeReason}</div>
                    )}
                  </td>
                  <td>{formatElapsed(row.elapsedSeconds)}</td>
                  <td>
                    {row.compensationKind ?? "—"}
                    {row.compensationAmountPence !== undefined && (
                      <div>£{(row.compensationAmountPence / 100).toFixed(2)}</div>
                    )}
                  </td>
                  <td>
                    {row.prolificActionStatus ?? "—"}
                    {row.actionError && (
                      <div className="bad">{row.actionError}</div>
                    )}
                  </td>
                  <td>
                    {row.outcome && row.outcome !== "completed" && (
                      <div className="button-row">
                        {!row.returnRequestedAt && (
                          <ActionButton
                            row={row}
                            action="request-return"
                            label="Request return"
                            busy={busy}
                            act={act}
                          />
                        )}
                        {row.compensationKind === "partial" &&
                          !row.bonusBatchId && (
                            <ActionButton
                              row={row}
                              action="prepare-bonus"
                              label="Prepare bonus"
                              busy={busy}
                              act={act}
                            />
                          )}
                        {row.bonusBatchId &&
                          row.prolificActionStatus === "bonus_prepared" && (
                            <ActionButton
                              row={row}
                              action="pay-bonus"
                              label="Pay bonus"
                              busy={busy}
                              act={act}
                            />
                          )}
                        {!row.paymentSubmittedAt &&
                          row.prolificActionStatus !== "resolved_manually" && (
                            <ActionButton
                              row={row}
                              action="resolve-manually"
                              label="Resolve manually"
                              busy={busy}
                              act={act}
                            />
                          )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ActionButton({
  row,
  action,
  label,
  busy,
  act,
}: {
  row: ParticipationOutcomeRecord;
  action: string;
  label: string;
  busy: string;
  act: (id: string, action: string) => Promise<void>;
}) {
  const key = `${row.id}:${action}`;
  return (
    <button
      type="button"
      disabled={Boolean(busy)}
      onClick={() => void act(row.id, action)}
    >
      {busy === key ? "Working…" : label}
    </button>
  );
}

function formatElapsed(seconds?: number): string {
  if (seconds === undefined) return "—";
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
