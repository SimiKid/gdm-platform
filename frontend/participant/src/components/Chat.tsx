import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, RoomEvent } from "matrix-js-sdk";
import { GDM_RECIPIENT_KEY } from "@gdm/shared";
import type { Session } from "@gdm/shared";
import SharedRanking from "./SharedRanking";
import { buildIdentities, identityFor, isBot } from "../study/identity";

interface Message {
  id: string;
  sender: string;
  body: string;
  isOwn: boolean;
  ts: number;
  /** True when the message is from the study bot (rendered as a nudge). */
  fromBot: boolean;
  /** Set when this is a private nudge for a single participant. */
  recipient: string | null;
}

/** targetEventId -> emoji -> { count, mine: my reaction event id if reacted }. */
type Reactions = Record<string, Record<string, { count: number; mine?: string }>>;

interface Props {
  client: MatrixClient;
  /** The study session (briefing, ranking, timer). Null on the dev fast-path. */
  session: Session | null;
  /** Fired once when the discussion timer reaches zero. */
  onTimeUp?: () => void;
}

const QUICK_EMOJI = ["👍", "👎", "❤️"];

const PANEL_WIDTH_KEY = "gdm-panel-width";
const PANEL_MIN = 280;
const PANEL_MAX = 640;

/** Keep the panel usable and leave the chat column at least ~360px. */
function clampPanelWidth(w: number): number {
  const max = Math.min(PANEL_MAX, window.innerWidth - 360);
  return Math.max(PANEL_MIN, Math.min(w, Math.max(PANEL_MIN, max)));
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

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export default function Chat({ client, session, onTimeUp }: Props) {
  const [activeRoomId, setActiveRoomId] = useState<string | null>(
    session?.roomId ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<Reactions>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Width of the resizable study side panel (persisted across reloads).
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    return saved ? clampPanelWidth(saved) : 340;
  });

  useEffect(() => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  function startPanelResize(e: ReactPointerEvent) {
    e.preventDefault();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) =>
      setPanelWidth(clampPanelWidth(window.innerWidth - ev.clientX));
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

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

  // Fire onTimeUp exactly once when the discussion timer hits zero.
  const endedRef = useRef(false);
  useEffect(() => {
    if (remaining === 0 && !endedRef.current) {
      endedRef.current = true;
      onTimeUp?.();
    }
  }, [remaining, onTimeUp]);

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
                if (msg.fromBot) {
                  return (
                    <div
                      key={msg.id}
                      className={`bot-message ${msg.recipient ? "private" : ""}`}
                    >
                      <div className="bot-label">
                        🤖 Assistant
                        {msg.recipient ? " · only you can see this" : ""}
                      </div>
                      <div className="bot-body">{msg.body}</div>
                    </div>
                  );
                }
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

      {/* ── Study side panel (resizable) ────────────── */}
      {session && (
        <div
          className="panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize task panel"
          tabIndex={0}
          onPointerDown={startPanelResize}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setPanelWidth((w) => clampPanelWidth(w + 24));
            }
            if (e.key === "ArrowRight") {
              e.preventDefault();
              setPanelWidth((w) => clampPanelWidth(w - 24));
            }
          }}
        />
      )}
      {session && (
        <aside
          className="panel-col"
          style={{ width: panelWidth, minWidth: panelWidth }}
        >
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
