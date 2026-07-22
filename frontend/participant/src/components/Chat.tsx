import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { ClientEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
import { GDM_RECIPIENT_KEY, MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { PublicSession } from "@gdm/shared";
import SharedRanking from "./SharedRanking";
import { botLabel, buildIdentities, identityFor, isBot } from "../study/identity";

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
  /** Local echo not yet confirmed by the server (its id is temporary). */
  pending: boolean;
}

interface Props {
  client: MatrixClient;
  /** The study session (briefing, ranking, timer). Null on the dev fast-path. */
  session: PublicSession | null;
  /** Fired once when the discussion timer reaches zero, with the final group ranking order. */
  onTimeUp?: (groupOrder: string[]) => void;
}

const PANEL_WIDTH_KEY = "gdm-panel-width";
const PANEL_MIN = 280;
const PANEL_MAX = 640;
const TYPING_SERVER_TIMEOUT_MS = 4000;
const TYPING_RENEW_INTERVAL_MS = 3000;
const TYPING_IDLE_TIMEOUT_MS = 1800;

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
  const [groupOrder, setGroupOrder] = useState<string[]>(session?.ranking.order ?? []);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [typingMembers, setTypingMembers] = useState<string[]>([]);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const messagesViewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const previousMessageCount = useRef(0);
  const isNearMessageEnd = useRef(true);
  const typingStartedAt = useRef<number | null>(null);
  const typingStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingRenewInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const cursorActivity = useRef({
    sampleCount: 0,
    distancePx: 0,
    lastX: 0,
    lastY: 0,
    hasPoint: false,
  });

  useEffect(
    () => () => {
      if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
      if (typingRenewInterval.current) clearInterval(typingRenewInterval.current);
    },
    [],
  );

  const sendBehavior = useCallback(
    async (
      type:
        | "typing-start"
        | "typing-stop"
        | "tab-hidden"
        | "tab-visible"
        | "cursor-activity",
      durationMs?: number,
      payload: Record<string, number> = {},
    ) => {
      if (!activeRoomId) return;
      try {
        await client.sendEvent(activeRoomId, MATRIX_EVENT_TYPES.behavior as never, {
          type,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...payload,
        } as never);
      } catch {
        // Telemetry must never block the participant's chat interaction.
      }
    },
    [activeRoomId, client],
  );

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

  // Rebuild messages from the live timeline on any change. Study rooms are
  // tiny, so a full rebuild is simplest and always consistent. Emoji
  // reactions are intentionally unsupported: the study is about turn-taking
  // in talking/typing, so participants must engage by writing.
  useEffect(() => {
    if (!activeRoomId) {
      setMessages([]);
      return;
    }

    function refresh() {
      const room = client.getRoom(activeRoomId!);
      if (!room) return;
      const events = room.getLiveTimeline().getEvents();
      const msgs: Message[] = [];
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
  }, [client, activeRoomId, userId]);

  // Matrix typing is ephemeral and drives the live indicator. Matching custom
  // behavior events make the start/stop intervals available in research data.
  useEffect(() => {
    if (!activeRoomId) return;
    function refreshTyping() {
      const members = client
        .getRoom(activeRoomId!)
        ?.getJoinedMembers()
        .filter((member) => member.userId !== userId && member.typing && !isBot(member.userId))
        .map((member) => identityFor(buildIdentities(
          client.getRoom(activeRoomId!)?.getJoinedMembers().map((item) => item.userId) ?? [],
        ), member.userId).name) ?? [];
      setTypingMembers(members);
    }
    client.on(RoomMemberEvent.Typing, refreshTyping);
    refreshTyping();
    return () => {
      client.off(RoomMemberEvent.Typing, refreshTyping);
    };
  }, [client, activeRoomId, userId]);

  useEffect(() => {
    if (!activeRoomId) return;
    function onVisibilityChange() {
      void sendBehavior(document.hidden ? "tab-hidden" : "tab-visible");
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [activeRoomId, sendBehavior]);

  // Batch pointer activity so research gets cursor engagement measures without
  // flooding Matrix with a raw event for every mouse movement.
  useEffect(() => {
    if (!activeRoomId) return;
    function onPointerMove(event: PointerEvent) {
      const activity = cursorActivity.current;
      if (activity.hasPoint) {
        activity.distancePx += Math.hypot(
          event.clientX - activity.lastX,
          event.clientY - activity.lastY,
        );
      }
      activity.sampleCount += 1;
      activity.lastX = event.clientX;
      activity.lastY = event.clientY;
      activity.hasPoint = true;
    }
    const interval = setInterval(() => {
      const activity = cursorActivity.current;
      if (activity.sampleCount > 0) {
        void sendBehavior("cursor-activity", undefined, {
          sampleCount: activity.sampleCount,
          distancePx: Math.round(activity.distancePx),
          lastX: Math.round(activity.lastX),
          lastY: Math.round(activity.lastY),
        });
      }
      cursorActivity.current = {
        sampleCount: 0,
        distancePx: 0,
        lastX: activity.lastX,
        lastY: activity.lastY,
        hasPoint: activity.hasPoint,
      };
    }, 10_000);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      clearInterval(interval);
    };
  }, [activeRoomId, sendBehavior]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    isNearMessageEnd.current = true;
    setNewMessageCount(0);
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    previousMessageCount.current = 0;
    isNearMessageEnd.current = true;
    setNewMessageCount(0);
  }, [activeRoomId]);

  // Keep following the conversation only while the participant is already at
  // the bottom. If they scroll up to read, preserve that position and surface
  // a WhatsApp-style count instead of pulling the viewport away.
  useEffect(() => {
    const previousCount = previousMessageCount.current;
    const addedCount = Math.max(0, messages.length - previousCount);
    const addedMessages =
      addedCount > 0 ? messages.slice(messages.length - addedCount) : [];
    previousMessageCount.current = messages.length;

    if (messages.length === 0) {
      setNewMessageCount(0);
      return;
    }
    if (
      previousCount === 0 ||
      isNearMessageEnd.current ||
      addedMessages.some((message) => message.isOwn)
    ) {
      scrollToLatest(previousCount === 0 ? "auto" : "smooth");
    } else if (addedCount > 0) {
      setNewMessageCount((count) => count + addedCount);
    }
  }, [messages, scrollToLatest]);

  function trackMessageScroll() {
    const viewport = messagesViewportRef.current;
    if (!viewport) return;
    const nearEnd =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
    isNearMessageEnd.current = nearEnd;
    if (nearEnd) setNewMessageCount(0);
  }

  // Fire onTimeUp exactly once when the discussion timer hits zero.
  const endedRef = useRef(false);
  const groupOrderRef = useRef(groupOrder);
  useEffect(() => { groupOrderRef.current = groupOrder; }, [groupOrder]);
  useEffect(() => {
    if (remaining === 0 && !endedRef.current) {
      endedRef.current = true;
      onTimeUp?.(groupOrderRef.current);
    }
  }, [remaining, onTimeUp]);

  const [sendError, setSendError] = useState(false);

  function stopTyping() {
    if (!activeRoomId || typingStartedAt.current === null) return;
    const durationMs = Date.now() - typingStartedAt.current;
    typingStartedAt.current = null;
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    typingStopTimer.current = null;
    if (typingRenewInterval.current) clearInterval(typingRenewInterval.current);
    typingRenewInterval.current = null;
    void client.sendTyping(activeRoomId, false, 0).catch(() => undefined);
    void sendBehavior("typing-stop", durationMs);
  }

  function updateInput(value: string) {
    setInput(value);
    if (!activeRoomId) return;
    if (value.trim() && typingStartedAt.current === null) {
      typingStartedAt.current = Date.now();
      void client
        .sendTyping(activeRoomId, true, TYPING_SERVER_TIMEOUT_MS)
        .catch(() => undefined);
      typingRenewInterval.current = setInterval(() => {
        if (typingStartedAt.current === null) return;
        void client
          .sendTyping(activeRoomId, true, TYPING_SERVER_TIMEOUT_MS)
          .catch(() => undefined);
      }, TYPING_RENEW_INTERVAL_MS);
      void sendBehavior("typing-start");
    }
    if (typingStopTimer.current) clearTimeout(typingStopTimer.current);
    if (!value.trim()) stopTyping();
    else typingStopTimer.current = setTimeout(stopTyping, TYPING_IDLE_TIMEOUT_MS);
  }

  async function sendMessage() {
    if (!input.trim() || !activeRoomId) return;
    const body = input.trim();
    stopTyping();
    setInput("");
    setSendError(false);
    try {
      await client.sendTextMessage(activeRoomId, body);
    } catch {
      // Don't lose the participant's words: restore them and say so.
      setInput((current) => current || body);
      setSendError(true);
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
            <div className="messages-shell">
              <div
                className="messages"
                ref={messagesViewportRef}
                onScroll={trackMessageScroll}
              >
                {messages.map((msg) => {
                  if (msg.fromBot) {
                    return (
                      <div
                        key={msg.id}
                        className={`bot-message ${msg.recipient ? "private" : ""}`}
                      >
                        <div className="bot-label">
                          <span>🤖 {botLabel(msg.sender)}</span>
                          {/* Zoom-style delivery badge: participants must
                              never be unsure who can see a nudge. */}
                          <span
                            className={`audience-badge ${
                              msg.recipient ? "badge-private" : "badge-public"
                            }`}
                          >
                            {msg.recipient
                              ? "🔒 Private message to you — only you can see this"
                              : "📢 Message to ALL in the group"}
                          </span>
                          <span className="bot-meta">{formatClock(msg.ts)}</span>
                        </div>
                        <div className="bot-body">{msg.body}</div>
                      </div>
                    );
                  }
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
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              {newMessageCount > 0 && (
                <button
                  type="button"
                  className="new-messages"
                  onClick={() => scrollToLatest()}
                >
                  {newMessageCount} new{" "}
                  {newMessageCount === 1 ? "message" : "messages"} ↓
                </button>
              )}
            </div>
            {sendError && (
              <p className="error" role="alert">
                Message not sent — please try again.
              </p>
            )}
            <div className="typing-indicator" aria-live="polite">
              {typingMembers.length > 0
                ? `${typingMembers.join(", ")} ${typingMembers.length === 1 ? "is" : "are"} typing...`
                : "\u00a0"}
            </div>
            <div className="message-input">
              <input
                placeholder="Type a message"
                value={input}
                onChange={(e) => updateInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void sendMessage()}
                onPaste={(e) => e.preventDefault()}
                autoFocus
              />
              <button onClick={() => void sendMessage()} aria-label="Send">
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
              onChange={setGroupOrder}
            />
          )}
        </aside>
      )}
    </div>
  );
}
