import { useEffect, useRef, useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, RoomEvent } from "matrix-js-sdk";
import type { Session } from "@gdm/shared";
import SharedRanking from "./SharedRanking";
import { buildIdentities, identityFor } from "../study/identity";

interface Message {
  id: string;
  sender: string;
  body: string;
  isOwn: boolean;
  ts: number;
}

/** targetEventId -> emoji -> { count, mine: my reaction event id if reacted }. */
type Reactions = Record<string, Record<string, { count: number; mine?: string }>>;

interface Props {
  client: MatrixClient;
  /** The study session (briefing, ranking, timer). Null on the dev fast-path. */
  session: Session | null;
}

const QUICK_EMOJI = ["👍", "👎", "❤️"];

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

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function Chat({ client, session }: Props) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    session?.roomId ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Reactions>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userId = client.getUserId() ?? "";
  const remaining = useCountdown(session?.startedAt, session?.durationMinutes);

  // Resolve the active room: session.roomId in study mode, else first joined.
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

  // Rebuild messages + reactions from the live timeline on any change. Study
  // rooms are tiny, so a full rebuild is simplest and always consistent.
  useEffect(() => {
    if (!activeRoomId) {
      setMessages([]);
      setReactions({});
      return;
    }

    function refresh() {
      const room = client.getRoom(activeRoomId!);
      if (!room) return;
      const events = room.getLiveTimeline().getEvents();
      const msgs: Message[] = [];
      const rx: Reactions = {};
      for (const e of events) {
        if (e.isRedacted()) continue;
        const type = e.getType();
        if (type === "m.room.message") {
          const content = e.getContent();
          const sender = e.getSender() ?? "unknown";
          msgs.push({
            id: e.getId() ?? crypto.randomUUID(),
            sender,
            body: typeof content.body === "string" ? content.body : "",
            isOwn: sender === userId,
            ts: e.getTs(),
          });
        } else if (type === "m.reaction") {
          const rel = e.getContent()["m.relates_to"] as
            | { rel_type?: string; event_id?: string; key?: string }
            | undefined;
          if (!rel || rel.rel_type !== "m.annotation" || !rel.event_id || !rel.key)
            continue;
          const bucket = (rx[rel.event_id] ??= {});
          const entry = (bucket[rel.key] ??= { count: 0 });
          entry.count++;
          if (e.getSender() === userId) entry.mine = e.getId() ?? undefined;
        }
      }
      setMessages(msgs);
      setReactions(rx);
    }

    refresh();
    client.on(RoomEvent.Timeline, refresh);
    client.on(RoomEvent.Redaction, refresh);
    return () => {
      client.off(RoomEvent.Timeline, refresh);
      client.off(RoomEvent.Redaction, refresh);
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

  async function toggleReaction(targetId: string, key: string) {
    setPickerFor(null);
    if (!activeRoomId) return;
    const mine = reactions[targetId]?.[key]?.mine;
    try {
      if (mine) {
        await client.redactEvent(activeRoomId, mine);
      } else {
        await client.sendEvent(activeRoomId, "m.reaction" as never, {
          "m.relates_to": { rel_type: "m.annotation", event_id: targetId, key },
        } as never);
      }
    } catch {
      /* ignore reaction errors */
    }
  }

  const room = activeRoomId ? client.getRoom(activeRoomId) : null;
  const title = session?.condition.name ?? room?.name ?? "Group Chat";
  const timerLow = remaining !== null && remaining <= 5 * 60_000;

  const identities = buildIdentities(
    room?.getJoinedMembers().map((m) => m.userId) ?? [],
  );
  const me = identityFor(identities, userId);

  return (
    <div className="study-layout">
      {/* ── Chat column ─────────────────────────────── */}
      <main className="chat-main">
        <div className="chat-header">
          <h2>{title}</h2>
          <span className="chat-user">
            <span className="user-dot" style={{ background: me.color }} />
            {me.name}
          </span>
        </div>
        {activeRoomId ? (
          <>
            <div className="messages">
              {messages.map((msg) => {
                const msgReactions = reactions[msg.id] ?? {};
                return (
                  <div
                    key={msg.id}
                    className={`message ${msg.isOwn ? "own" : "other"}`}
                  >
                    {!msg.isOwn && (
                      <div
                        className="sender"
                        style={{ color: identityFor(identities, msg.sender).color }}
                      >
                        {identityFor(identities, msg.sender).name}
                      </div>
                    )}
                    <div className="body">{msg.body}</div>
                    <span className="meta">{formatClock(msg.ts)}</span>

                    <button
                      type="button"
                      className="react-btn"
                      aria-label="Add reaction"
                      onClick={() =>
                        setPickerFor((cur) => (cur === msg.id ? null : msg.id))
                      }
                    >
                      +
                    </button>
                    {pickerFor === msg.id && (
                      <div className="emoji-picker">
                        {QUICK_EMOJI.map((em) => (
                          <button
                            key={em}
                            type="button"
                            onClick={() => toggleReaction(msg.id, em)}
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    )}

                    {Object.keys(msgReactions).length > 0 && (
                      <div className="reactions">
                        {Object.entries(msgReactions).map(([key, r]) => (
                          <button
                            key={key}
                            type="button"
                            className={`reaction ${r.mine ? "mine" : ""}`}
                            onClick={() => toggleReaction(msg.id, key)}
                          >
                            {key} {r.count}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            <div className="message-input">
              <input
                placeholder="Type a message"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                autoFocus
              />
              <button onClick={sendMessage} aria-label="Send">
                ➤
              </button>
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
