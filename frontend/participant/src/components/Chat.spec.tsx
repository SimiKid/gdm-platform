import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { PublicSession } from "@gdm/shared";
import Chat from "./Chat";

const ROOM_ID = "!room:test";

interface FakeMessage {
  id: string;
  sender: string;
  body: string;
  ts: number;
}

function matrixMessage({ id, sender, body, ts }: FakeMessage) {
  return {
    isRedacted: () => false,
    getType: () => "m.room.message",
    getContent: () => ({ body }),
    getSender: () => sender,
    getId: () => id,
    getTs: () => ts,
    status: null,
  };
}

function createClient(
  initialMessages: FakeMessage[] = [],
  initialMemberIds: string[] = [],
) {
  const events = initialMessages.map(matrixMessage);
  let memberIds = initialMemberIds;
  const listeners = new Map<unknown, Set<(...args: unknown[]) => void>>();
  const room = {
    roomId: ROOM_ID,
    name: "Test room",
    getLiveTimeline: () => ({ getEvents: () => events }),
    getJoinedMembers: () => memberIds.map((userId) => ({ userId })),
  };
  const sendEvent = vi.fn().mockResolvedValue({ event_id: "$event" });
  const sendTyping = vi.fn().mockResolvedValue({});
  const sendTextMessage = vi.fn().mockResolvedValue({ event_id: "$message" });
  const client = {
    getUserId: () => "@participant:test",
    getRooms: () => [room],
    getRoom: () => room,
    on: vi.fn((event: unknown, handler: (...args: unknown[]) => void) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    }),
    off: vi.fn((event: unknown, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    sendEvent,
    sendTyping,
    sendTextMessage,
    redactEvent: vi.fn().mockResolvedValue({ event_id: "$redaction" }),
  };

  function pushMessage(message: FakeMessage) {
    const event = matrixMessage(message);
    events.push(event);
    for (const handler of listeners.get(RoomEvent.Timeline) ?? []) {
      handler(event, room);
    }
  }

  function setJoinedMembers(nextMemberIds: string[]) {
    memberIds = nextMemberIds;
    for (const handler of listeners.get(RoomMemberEvent.Membership) ?? []) {
      handler();
    }
  }

  return {
    client: client as unknown as MatrixClient,
    sendEvent,
    sendTyping,
    sendTextMessage,
    pushMessage,
    setJoinedMembers,
  };
}

const studySession = {
  roomId: ROOM_ID,
  condition: {
    name: "Test condition",
    groupSize: 3,
    config: { protectedEndMinutes: 0 },
  },
  briefing: { title: "Test task", html: "<p>Briefing</p>" },
  rankingTask: { id: "task", title: "Rank", items: [] },
  ranking: {
    taskId: "task",
    order: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "system",
  },
  durationMinutes: 5,
} as unknown as PublicSession;

describe("Chat telemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renews Matrix typing while input remains active and stops on clear", () => {
    const { client, sendTyping } = createClient();
    render(<Chat client={client} session={null} />);
    const input = screen.getByPlaceholderText("Type a message");

    fireEvent.change(input, { target: { value: "working" } });
    expect(sendTyping).toHaveBeenLastCalledWith(ROOM_ID, true, 4000);

    act(() => vi.advanceTimersByTime(1500));
    fireEvent.change(input, { target: { value: "working continuously" } });
    act(() => vi.advanceTimersByTime(1500));

    expect(sendTyping).toHaveBeenCalledTimes(2);
    expect(sendTyping).toHaveBeenLastCalledWith(ROOM_ID, true, 4000);

    fireEvent.change(input, { target: { value: "" } });
    expect(sendTyping).toHaveBeenLastCalledWith(ROOM_ID, false, 0);

    act(() => vi.advanceTimersByTime(6000));
    expect(sendTyping).toHaveBeenCalledTimes(3);
  });

  it("normalizes cursor coordinates to Matrix-compatible integers", () => {
    const { client, sendEvent } = createClient();
    render(<Chat client={client} session={null} />);

    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 101.25, clientY: 122.75 }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 151.75, clientY: 172.25 }),
    );
    act(() => vi.advanceTimersByTime(10_000));

    expect(sendEvent).toHaveBeenCalledWith(
      ROOM_ID,
      MATRIX_EVENT_TYPES.behavior,
      {
        type: "cursor-activity",
        sampleCount: 2,
        distancePx: 71,
        lastX: 152,
        lastY: 172,
      },
    );
  });

  it("shows a timestamp on bot messages", () => {
    const ts = new Date(2026, 0, 2, 9, 5).getTime();
    const { client } = createClient([
      {
        id: "$bot",
        sender: "@gdm_bot:test",
        body: "Please make room for quieter members.",
        ts,
      },
    ]);

    render(<Chat client={client} session={null} />);

    expect(screen.getByText("🤖 Assistant")).toBeInTheDocument();
    expect(screen.getByText("9:05")).toHaveClass("bot-meta");
  });

  it("shows a neutral loading state until the complete participant membership arrives", () => {
    const { client, setJoinedMembers } = createClient([], ["@alpha:test"]);
    render(<Chat client={client} session={studySession} />);

    expect(screen.getByText("Loading group...")).toBeInTheDocument();
    expect(screen.queryByText("Gray")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Type a message")).not.toBeInTheDocument();

    act(() => {
      setJoinedMembers(["@alpha:test", "@beta:test", "@participant:test"]);
    });

    expect(screen.queryByText("Loading group...")).not.toBeInTheDocument();
    expect(screen.getByText("Green")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type a message")).toBeInTheDocument();
  });

  it("preserves a scrolled-up position and counts new messages", () => {
    const { client, pushMessage } = createClient([
      {
        id: "$first",
        sender: "@other:test",
        body: "First message",
        ts: Date.now(),
      },
    ]);
    const { container } = render(<Chat client={client} session={null} />);
    const viewport = container.querySelector(".messages") as HTMLDivElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(viewport);

    act(() => {
      pushMessage({
        id: "$second",
        sender: "@other:test",
        body: "Second message",
        ts: Date.now() + 1,
      });
      pushMessage({
        id: "$third",
        sender: "@other:test",
        body: "Third message",
        ts: Date.now() + 2,
      });
    });

    const indicator = screen.getByRole("button", { name: "2 new messages ↓" });
    expect(indicator).toBeInTheDocument();
    fireEvent.click(indicator);
    expect(indicator).not.toBeInTheDocument();
  });

  it("prevents pasting into the message input", () => {
    const { client } = createClient();
    render(<Chat client={client} session={null} />);
    const input = screen.getByPlaceholderText("Type a message");
    const paste = new Event("paste", { bubbles: true, cancelable: true });

    expect(fireEvent(input, paste)).toBe(false);
    expect(paste.defaultPrevented).toBe(true);
  });

  it("inserts newlines with Shift+Enter and sends with Enter", () => {
    const { client, sendTextMessage } = createClient();
    render(<Chat client={client} session={null} />);
    const input = screen.getByPlaceholderText("Type a message");

    fireEvent.change(input, { target: { value: "First line\nSecond line" } });
    expect(
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true }),
    ).toBe(true);
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("First line\nSecond line");

    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(sendTextMessage).toHaveBeenCalledWith(
      ROOM_ID,
      "First line\nSecond line",
    );
  });
});
