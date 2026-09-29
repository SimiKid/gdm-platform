import { FALLBACK_IDENTITY } from "@gdm/shared";
import {
  formatClock,
  formatShare,
  type ComparisonRow,
  type NudgeComparison,
  type ParticipantIdentity,
  type SessionTimeline,
} from "../../session-detail";

/** One nudge: when, to whom, what it said, and each member's share before → after. */
export default function NudgeBlock({
  index,
  comparison,
  timeline,
  identities,
}: {
  index: number;
  comparison: NudgeComparison;
  timeline: SessionTimeline | null;
  identities: ParticipantIdentity[];
}) {
  const { nudge, rows, windowIndex, basis, afterUntil, live, activeBefore, activeAfter } = comparison;
  const colorOf = (userId: string) => identities.find((i) => i.userId === userId)?.color ?? FALLBACK_IDENTITY.color;
  const clock = (t: number) => (timeline ? formatClock(t - timeline.start) : new Date(t).toLocaleTimeString());
  const beforeLabel = windowIndex === null ? "window not linked" : `window ${windowIndex + 1}`;
  const afterLabel =
    basis === "window"
      ? `window ${windowIndex! + 2}`
      : `messages ${clock(nudge.at)}–${clock(afterUntil!)}${live ? " so far" : ""}`;
  return (
    <div className="nudge-block">
      <div className="nudge-head">
        <strong>#{index}</strong>
        <span>{clock(nudge.at)}</span>
        <span className={`status ${nudge.audience === "private" ? "waiting" : "running"}`}>{nudge.audience}</span>
        <span>target {nudge.targetNames.join(", ")}</span>
        <span className="muted">
          {beforeLabel} → {afterLabel}
        </span>
      </div>
      <p className="muted nudge-text">“{nudge.message}”</p>
      {basis === "messages" && (
        <p className="basis-note">
          No bot window was evaluated after this nudge
          {live ? " yet" : " (the chat ended first)"}, so both sides are plain message shares: before
          = the messages in {windowIndex === null ? "the triggering window" : beforeLabel}, after = every participant
          message from the nudge to {live ? "now" : "the end of the chat"}. The two spans differ in length, so compare
          shares, not counts.
        </p>
      )}
      <div className="table-wrap compact">
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Role</th>
              <th>{basis === "window" ? "Share" : "Message share"} before → after</th>
              <th>Messages before → after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ComparisonRowView
                key={`${row.userId}-${row.role}`}
                row={row}
                color={colorOf(row.userId)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <span className="muted">
        Active participants {activeBefore} → {activeAfter}
      </span>
    </div>
  );
}

const ROLE_LABEL: Record<ComparisonRow["role"], string> = {
  target: "target",
  quiet: "quiet member",
  unaddressed: "other",
};

function ComparisonRowView({ row, color }: { row: ComparisonRow; color: string }) {
  return (
    <tr>
      <td>
        <span className="swatch dot" style={{ background: color, marginRight: 6 }} aria-hidden />
        {row.name}
      </td>
      <td>{ROLE_LABEL[row.role]}</td>
      <td>
        {formatShare(row.before.share)} → {formatShare(row.after.share)}
      </td>
      <td>
        {row.before.messageCount} → {row.after.messageCount}
      </td>
    </tr>
  );
}
