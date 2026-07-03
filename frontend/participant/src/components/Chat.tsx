import { useEffect, useRef, useState } from "react";
import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { ClientEvent, RoomEvent } from "matrix-js-sdk";
import type { Session } from "@gdm/shared";
import SharedRanking from "./SharedRanking";

interface Message {
  id: string;
  sender: string;
  body: string;
  isOwn: boolean;
}

interface Props {
  client: MatrixClient;
  /** The study session (briefing, ranking, timer). Null on the dev fast-path. */
  session: Session | null;
}

/** Countdown to the end of the discussion, in ms (null if no timer). */
function useCountdown(startedAt?: string, durationMinutes?: number) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt || !durationMinutes) return;
    const end = new Date(startedAt).getTime() + durationMinutes * 60_000;
    const tick = () => setRemaining(Math.max(0, end - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMinutes]);
  return remaining;
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Chat({ client, session }: Props) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    session?.roomId ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userId = client.getUserId() ?? "";
  const displayName = userId.replace(/:.*$/, "").replace(/^@/, "");
  const remaining = useCountdown(session?.startedAt, session?.durationMinutes);

  // Resolve the active room. In study mode it's session.roomId; on the dev
  // fast-path fall back to the first joined room (and update as rooms sync).
  useEffect(() => {
    if (session?.roomId) {
      setActiveRoomId(session.roomId);
      return;
    }
    function pickFirst() {
      const joined = client.getRooms();
      if (joined.length > 0) setActiveRoomId((cur) => cur ?? joined[0].roomId);
    }
    pickFirst();
    client.on(ClientEvent.Room, pickFirst);
    return () => {
      client.off(ClientEvent.Room, pickFirst);
    };
  }, [client, session]);

  // Load timeline for the active room + listen for new messages.
  useEffect(() => {
    if (!activeRoomId) {
      setMessages([]);
      return;
    }
    const room = client.getRoom(activeRoomId);

    function toMessage(event: MatrixEvent): Message {
      const content = event.getContent();
      const sender = event.getSender() ?? "unknown";
      return {
        id: event.getId() ?? crypto.randomUUID(),
        sender,
        body: typeof content.body === "string" ? content.body : "",
        isOwn: sender === userId,
      };
    }

    if (room) {
      setMessages(
        room
          .getLiveTimeline()
          .getEvents()
          .filter((e) => e.getType() === "m.room.message")
          .map(toMessage),
      );
    }

    function onTimeline(event: MatrixEvent) {
      if (event.getRoomId() !== activeRoomId) return;
      if (event.getType() !== "m.room.message") return;
      setMessages((prev) => [...prev, toMessage(event)]);
    }
    client.on(RoomEvent.Timeline, onTimeline);
    return () => {
      client.off(RoomEvent.Timeline, onTimeline);
    };
  }, [client, activeRoomId, userId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || !activeRoomId) return;
    const body = input.trim();
    setInput("");
    await client.sendTextMessage(activeRoomId, body);
  }

  const room = activeRoomId ? client.getRoom(activeRoomId) : null;
  const title = session?.condition.name ?? room?.name ?? "Group Chat";
  const timerLow = remaining !== null && remaining <= 5 * 60_000;

  return (
    <div className="study-layout">
      {/* ── Chat column ─────────────────────────────── */}
      <main className="chat-main">
        <div className="chat-header">
          <h2>{title}</h2>
          <span className="chat-user">{displayName}</span>
        </div>
        {activeRoomId ? (
          <>
            <div className="messages">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`message ${msg.isOwn ? "own" : "other"}`}
                >
                  <div className="sender">
                    {msg.isOwn
                      ? "You"
                      : msg.sender.replace(/:.*$/, "").replace(/^@/, "")}
                  </div>
                  <div className="body">{msg.body}</div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <div className="message-input">
              <input
                placeholder="Type a message..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                autoFocus
              />
              <button onClick={sendMessage}>Send</button>
            </div>
          </>
        ) : (
          <div className="no-room">Connecting to the group room...</div>
        )}
      </main>

      {/* ── Study side panel ────────────────────────── */}
      {session && (
        <aside className="panel-col">
          {remaining !== null && (
            <div className={`timer ${timerLow ? "low" : ""}`}>
              {remaining === 0
                ? "Time is up"
                : `${formatMs(remaining)} left${timerLow ? " — wrap up!" : ""}`}
            </div>
          )}
          <section className="briefing">
            <h3>{session.briefing.title}</h3>
            <div
              className="briefing-body"
              // Trusted, server-authored briefing HTML.
              dangerouslySetInnerHTML={{ __html: session.briefing.html }}
            />
          </section>
          {activeRoomId && (
            <SharedRanking
              client={client}
              roomId={activeRoomId}
              task={session.rankingTask}
              initial={session.ranking}
            />
          )}
        </aside>
      )}
    </div>
  );
}
