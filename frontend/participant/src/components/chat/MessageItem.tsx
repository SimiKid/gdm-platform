import type { Identity } from "@gdm/shared";
import { identityFor } from "@gdm/shared";
import { splitMentions } from "../../study/mentions";
import type { ChatMessage } from "../../hooks/useRoomMessages";

interface Props {
  message: ChatMessage;
  identities: Map<string, Identity>;
  /** Every participant name in the room, used to highlight mentions. */
  mentionNames: string[];
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** One chat line: a participant message, or a bot nudge with its audience. */
export default function MessageItem({ message, identities, mentionNames }: Props) {
  if (message.fromBot) {
    return (
      <div className={`bot-message ${message.recipient ? "private" : ""}`}>
        <div className="bot-label">
          <span>🤖 Assistant</span>
          {/* Zoom-style delivery badge: participants must
              never be unsure who can see a nudge. */}
          <span
            className={`audience-badge ${
              message.recipient ? "badge-private" : "badge-public"
            }`}
          >
            {message.recipient
              ? "🔒 Private message to you (only you can see this)"
              : "📢 Message to ALL in the group"}
          </span>
          <span className="bot-meta">{formatClock(message.ts)}</span>
        </div>
        <div className="bot-body">{message.body}</div>
      </div>
    );
  }

  const sender = identityFor(identities, message.sender);
  return (
    <div className={`message ${message.isOwn ? "own" : "other"}`}>
      {!message.isOwn && (
        <div className="sender" style={{ color: sender.color }}>
          {sender.name}
        </div>
      )}
      <div className="body">
        {splitMentions(message.body, mentionNames).map((seg, i) =>
          seg.type === "mention" ? (
            <span key={i} className="mention">
              {seg.value}
            </span>
          ) : (
            seg.value
          ),
        )}
      </div>
      <span className="meta">{formatClock(message.ts)}</span>
    </div>
  );
}
