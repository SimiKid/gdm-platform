import { act, fireEvent, render, screen } from "@testing-library/react";
import type { MatrixClient } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { Ranking, RankingTask } from "@gdm/shared";
import SharedRanking from "./SharedRanking";

const ROOM_ID = "!ranking:test";
const USER_ID = "@participant:test";
const OTHER_ID = "@other:test";

const task: RankingTask = {
  id: "task",
  title: "Rank the items",
  items: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
};

const initial: Ranking = {
  taskId: task.id,
  order: ["a", "b", "c"],
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "system",
};

function createClient() {
  const timelineHandlers = new Set<(event: unknown) => void>();
  const room = {
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getJoinedMembers: () => [
      { userId: USER_ID },
      { userId: OTHER_ID },
    ],
  };
  const sendEvent = vi.fn().mockResolvedValue({ event_id: "$ranking" });
  const client = {
    getUserId: () => USER_ID,
    getRoom: () => room,
    sendEvent,
    on: vi.fn((event: unknown, handler: (matrixEvent: unknown) => void) => {
      if (event === RoomEvent.Timeline) timelineHandlers.add(handler);
    }),
    off: vi.fn((event: unknown, handler: (matrixEvent: unknown) => void) => {
      if (event === RoomEvent.Timeline) timelineHandlers.delete(handler);
    }),
  };

  function emitRanking(content: Ranking) {
    const event = {
      getRoomId: () => ROOM_ID,
      getType: () => MATRIX_EVENT_TYPES.ranking,
      getContent: () => content,
    };
    for (const handler of timelineHandlers) handler(event);
  }

  return {
    client: client as unknown as MatrixClient,
    emitRanking,
    sendEvent,
  };
}

function dataTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "",
    dropEffect: "",
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
  };
}

describe("SharedRanking", () => {
  it("broadcasts an arbitrary drag-and-drop reorder", () => {
    const { client, sendEvent } = createClient();
    render(
      <SharedRanking
        client={client}
        roomId={ROOM_ID}
        task={task}
        initial={initial}
      />,
    );
    const items = screen.getAllByRole("listitem");
    const transfer = dataTransfer();

    fireEvent.dragStart(items[2], { dataTransfer: transfer });
    fireEvent.dragOver(items[0], { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("list"), { dataTransfer: transfer });

    expect(sendEvent).toHaveBeenCalledWith(
      ROOM_ID,
      MATRIX_EVENT_TYPES.ranking,
      expect.objectContaining({
        order: ["c", "a", "b"],
        movement: { itemId: "c", from: 2, to: 0 },
      }),
    );
  });

  it("highlights and describes a ranking move from another participant", () => {
    const { client, emitRanking } = createClient();
    render(
      <SharedRanking
        client={client}
        roomId={ROOM_ID}
        task={task}
        initial={initial}
      />,
    );

    act(() => {
      emitRanking({
        ...initial,
        order: ["b", "a", "c"],
        updatedBy: OTHER_ID,
        movement: { itemId: "b", from: 1, to: 0 },
      });
    });

    expect(screen.getByText(/moved B from #2 to #1/)).toBeInTheDocument();
    expect(screen.getByText("B").closest("li")).toHaveClass("remote-move");
  });
});
