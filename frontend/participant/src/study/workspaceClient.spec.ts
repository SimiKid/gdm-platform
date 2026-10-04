import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceClient } from "./workspaceClient";

afterEach(() => vi.unstubAllGlobals());

describe("workspaceClient", () => {
  it("POSTs to the workspace endpoint with the participant token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ mode: "etherpad" }) })),
    );
    await expect(workspaceClient.prepare("token-1")).resolves.toEqual({
      mode: "etherpad",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/workspace\/prepare$/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
        body: "{}",
      }),
    );
  });

  it("sends the session id for a pad and targets the finish/leave endpoints", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await workspaceClient.pad("t", "exit", "session-1");
    await workspaceClient.finish("t", "pad-1");
    await workspaceClient.leave("t");
    const calls = vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url.split("/workspace/")[1])).toEqual([
      "pads/exit",
      "finish/pad-1",
      "leave",
    ]);
    expect(calls[0][1].body).toBe(JSON.stringify({ sessionId: "session-1" }));
  });

  it("surfaces the server message and code of a rejected request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ message: "Not yet", code: "DISCUSSION_PENDING" }),
      })),
    );
    await expect(workspaceClient.pad("t", "exit")).rejects.toMatchObject({
      message: "Not yet",
      code: "DISCUSSION_PENDING",
    });
  });

  it("falls back to a generic message when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => {
          throw new SyntaxError("not json");
        },
      })),
    );
    await expect(workspaceClient.leave("t")).rejects.toThrow(
      "The writing workspace is unavailable. Please retry.",
    );
  });
});
