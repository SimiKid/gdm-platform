import { useEffect, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { GDM_RECIPIENT_KEY, isBot } from "@gdm/shared";

export interface ChatMessage {
  id: string;
  sender: string;
  body: string;
  isOwn: boolean;
  ts: number;
  /** True when the message is from the study bot (rendered as a nudge). */
  fromBot: boolean;
  /** Set when this is a private nudge for a single participant. */
  recipient: string | null;
  /** Local echo not yet confirmed by the server (its id is temporary). */
  pending: boolean;
}

/**
 * The room's text messages, rebuilt from the live timeline on any change.
 * Study rooms are tiny, so a full rebuild is simplest and always consistent.
 * Emoji reactions are intentionally unsupported: the study is about
 * turn-taking in talking/typing, so participants must engage by writing.
 */
export function useRoomMessages(
  client: MatrixClient,
  roomId: string | null,
  userId: string,
): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      return;
    }
    const activeRoomId = roomId;

    function refresh() {
      const room = client.getRoom(activeRoomId);
      if (!room) return;
      const events = room.getLiveTimeline().getEvents();
      const msgs: ChatMessage[] = [];
      for (const e of events) {
        if (e.isRedacted()) continue;
        const type = e.getType();
        if (type === "m.room.message") {
          const content = e.getContent();
          const sender = e.getSender() ?? "unknown";
          const recipientRaw = content[GDM_RECIPIENT_KEY];
          const recipient =
            typeof recipientRaw === "string" ? recipientRaw : null;
          // A private nudge is only shown to its recipient.
          if (recipient && recipient !== userId) continue;
          msgs.push({
            id: e.getId() ?? crypto.randomUUID(),
            sender,
            body: typeof content.body === "string" ? content.body : "",
            isOwn: sender === userId,
            ts: e.getTs(),
            fromBot: isBot(sender),
            recipient,
            pending: e.status !== null,
          });
        }
      }
      setMessages(msgs);
    }

    refresh();
    client.on(RoomEvent.Timeline, refresh);
    client.on(RoomEvent.Redaction, refresh);
    // Fired when a local echo is confirmed and swaps to its real event id.
    client.on(RoomEvent.LocalEchoUpdated, refresh);
    return () => {
      client.off(RoomEvent.Timeline, refresh);
      client.off(RoomEvent.Redaction, refresh);
      client.off(RoomEvent.LocalEchoUpdated, refresh);
    };
  }, [client, roomId, userId]);

  return messages;
}
