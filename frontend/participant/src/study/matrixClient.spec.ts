import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const state = { syncState: "PREPARED", pages: 0 };
  const timeline = {
    getPaginationToken: vi.fn(() => (state.pages > 0 ? "token" : null)),
  };
  const client = {
    startClient: vi.fn(async () => undefined),
    once: vi.fn((_event: string, handler: (syncState: string) => void) => {
      queueMicrotask(() => handler(state.syncState));
    }),
    getRoom: vi.fn(() => ({ getLiveTimeline: () => timeline })),
    paginateEventTimeline: vi.fn(async () => {
      state.pages -= 1;
      return true;
    }),
  };
  return { state, client, createClient: vi.fn(() => client) };
});

vi.mock("matrix-js-sdk", () => ({
  createClient: sdk.createClient,
  ClientEvent: { Sync: "sync" },
  EventTimeline: { BACKWARDS: "b" },
}));

import { startMatrixClient } from "./matrixClient";

const credentials = {
  homeserverUrl: "http://matrix.test",
  userId: "@p:test",
  accessToken: "token",
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.state.syncState = "PREPARED";
  sdk.state.pages = 0;
});

describe("startMatrixClient", () => {
  it("creates, syncs and backfills the room timeline", async () => {
    sdk.state.pages = 2;
    const client = await startMatrixClient({ ...credentials, roomId: "!room:test" });
    expect(client).toBe(sdk.client);
    expect(sdk.createClient).toHaveBeenCalledWith({
      baseUrl: "http://matrix.test",
      accessToken: "token",
      userId: "@p:test",
    });
    expect(sdk.client.startClient).toHaveBeenCalledWith({ initialSyncLimit: 20 });
    expect(sdk.client.paginateEventTimeline).toHaveBeenCalledTimes(2);
  });

  it("skips the backfill without a room", async () => {
    await startMatrixClient(credentials);
    expect(sdk.client.getRoom).not.toHaveBeenCalled();
  });

  it("rejects when the first sync fails", async () => {
    sdk.state.syncState = "ERROR";
    await expect(startMatrixClient(credentials)).rejects.toThrow(
      "Chat connection failed (ERROR)",
    );
  });
});
