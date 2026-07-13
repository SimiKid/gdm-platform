import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import Chat from "./Chat";

const ROOM_ID = "!room:test";

function createClient() {
  const room = {
    roomId: ROOM_ID,
    name: "Test room",
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getJoinedMembers: () => [],
  };
  const sendEvent = vi.fn().mockResolvedValue({ event_id: "$event" });
  const sendTyping = vi.fn().mockResolvedValue({});
  const client = {
    getUserId: () => "@participant:test",
    getRooms: () => [room],
    getRoom: () => room,
    on: vi.fn(),
    off: vi.fn(),
    sendEvent,
    sendTyping,
    sendTextMessage: vi.fn().mockResolvedValue({ event_id: "$message" }),
    redactEvent: vi.fn().mockResolvedValue({ event_id: "$redaction" }),
  };

  return { client: client as unknown as MatrixClient, sendEvent, sendTyping };
}

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
});
