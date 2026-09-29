import { formatClock, formatShare, type ParticipantIdentity, type SessionTimeline } from "../../session-detail";

/** Collapsible raw view: every evaluated window with each member's share. */
export default function WindowTable({
  timeline,
  identities,
}: {
  timeline: SessionTimeline;
  identities: ParticipantIdentity[];
}) {
  return (
    <details className="window-table">
      <summary>Window table</summary>
      <div className="table-wrap compact">
        <table>
          <thead>
            <tr>
              <th>Window</th>
              <th>Time</th>
              <th>Outcome</th>
              {identities.map((p) => (
                <th key={p.userId ?? p.name}>{p.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {timeline.windows.map((w) => (
              <tr key={w.index}>
                <td>{w.index + 1}</td>
                <td>
                  {formatClock(w.start - timeline.start)}–{formatClock(w.end - timeline.start)}
                </td>
                <td>{w.outcome}</td>
                {identities.map((p) => {
                  const s = p.userId ? w.shares.get(p.userId) : undefined;
                  return (
                    <td key={p.userId ?? p.name}>
                      {s ? `${formatShare(s.share)} · ${s.messageCount} msgs` : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
