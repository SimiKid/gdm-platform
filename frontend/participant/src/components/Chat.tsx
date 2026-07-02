import { useEffect, useRef, useState } from "react";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";

interface Message {
  id: string;
  sender: string;
  body: string;
  isOwn: boolean;
}

interface Props {
  client: MatrixClient;
}

export default function Chat({ client }: Props) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userId = client.getUserId() ?? "";
  const displayName = userId.replace(/:.*$/, "").replace(/^@/, "");

  // Keep room list in sync
  useEffect(() => {
    function updateRooms() {
      const joined = client.getRooms();
      setRooms(joined);
      // Auto-select first room if none active
      if (!activeRoomId && joined.length > 0) {
        setActiveRoomId(joined[0].roomId);
      }
    }
    updateRooms();
    client.on("Room" as any, updateRooms);
    return () => {
      client.off("Room" as any, updateRooms);
    };
  }, [client, activeRoomId]);

  // Load timeline for active room + listen for new messages
  useEffect(() => {
    if (!activeRoomId) {
      setMessages([]);
      return;
    }

    const room = client.getRoom(activeRoomId);
    if (!room) return;

    const timeline = room.getLiveTimeline().getEvents();
    setMessages(
      timeline
        .filter((e) => e.getType() === "m.room.message")
        .map((e) => toMessage(e)),
    );

    function onTimeline(event: MatrixEvent) {
      if (event.getRoomId() !== activeRoomId) return;
      if (event.getType() !== "m.room.message") return;
      setMessages((prev) => [...prev, toMessage(event)]);
    }

    client.on(RoomEvent.Timeline, onTimeline);
    return () => {
      client.off(RoomEvent.Timeline, onTimeline);
    };
  }, [client, activeRoomId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  async function sendMessage() {
    if (!input.trim() || !activeRoomId) return;
    const body = input.trim();
    setInput("");
    await client.sendTextMessage(activeRoomId, body);
  }

  const activeRoom = activeRoomId ? client.getRoom(activeRoomId) : null;
  const activeRoomName = activeRoom?.name ?? "Group Chat";

  return (
    <div className="chat-layout">
      {/* ── Sidebar ──────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-user">{displayName}</span>
        </div>
        <nav className="sidebar-rooms">
          {rooms.map((room) => (
            <button
              key={room.roomId}
              className={`sidebar-room ${room.roomId === activeRoomId ? "active" : ""}`}
              onClick={() => setActiveRoomId(room.roomId)}
              title={room.roomId}
            >
              <span className="room-name">{room.name || "Unnamed Room"}</span>
            </button>
          ))}
          {rooms.length === 0 && (
            <p className="sidebar-empty">No rooms yet</p>
          )}
        </nav>
      </aside>

      {/* ── Main chat area ───────────────────────────── */}
      <main className="chat-main">
        {activeRoomId ? (
          <>
            <div className="chat-header">
              <h2>{activeRoomName}</h2>
            </div>
            <div className="messages">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`message ${msg.isOwn ? "own" : "other"}`}
                >
                  <div className="sender">
                    {msg.isOwn ? "You" : msg.sender.replace(/:.*$/, "").replace(/^@/, "")}
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
          <div className="no-room">
            Waiting for a study session to begin...
          </div>
        )}
      </main>
    </div>
  );
}
