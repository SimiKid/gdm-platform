import {
  formatClock,
  type Engagement,
  type EngagementSummary,
  type ParticipantIdentity,
} from "../../session-detail";

/** Per-person activity (messages, typing, tab switches, ranking moves) plus totals. */
export default function ParticipantsTable({
  identities,
  engagement,
}: {
  identities: ParticipantIdentity[];
  engagement: EngagementSummary;
}) {
  return (
    <div className="table-wrap fit">
      <table className="participants" aria-label="Participants">
        <thead>
          <tr>
            <th>Participant</th>
            <th>Messages</th>
            <th>Typing</th>
            <th>Tab switches</th>
            <th>Ranking moves</th>
          </tr>
        </thead>
        <tbody>
          {identities.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No participants yet.
              </td>
            </tr>
          )}
          {identities.map((p) => {
            const e = p.userId ? engagement.perUser.get(p.userId) : undefined;
            return (
              <tr key={p.userId ?? p.name}>
                <td>
                  <span className="swatch dot" style={{ background: p.color }} aria-hidden />
                  <strong>{p.name}</strong>
                </td>
                {e ? (
                  <EngagementCells e={e} />
                ) : (
                  <td colSpan={4} className="muted">
                    no activity yet
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        {identities.length > 0 && (
          <tfoot>
            <tr>
              <td>All</td>
              <EngagementCells
                e={engagement.totals}
                botMessages={engagement.botMessages}
              />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function EngagementCells({ e, botMessages = 0 }: { e: Engagement; botMessages?: number }) {
  return (
    <>
      <td>
        {e.messages}
        {botMessages > 0 && <span className="muted"> + {botMessages} bot</span>}
      </td>
      <td>{formatClock(e.typingMs)}</td>
      <td>{e.tabHidden}</td>
      <td>{e.rankingMoves}</td>
    </>
  );
}
