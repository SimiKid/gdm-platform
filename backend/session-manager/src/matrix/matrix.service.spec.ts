import { describe, it, expect, beforeEach, vi } from "vitest";
import { MatrixService } from "./matrix.service";

describe("MatrixService", () => {
  let svc: MatrixService;
  beforeEach(() => {
    svc = new MatrixService();
  });

  it("registerUser POSTs to /register and returns creds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ user_id: "@x:localhost", access_token: "tok" }),
      })),
    );
    const creds = await svc.registerUser("gdm");
    expect(creds).toEqual({ userId: "@x:localhost", accessToken: "tok" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/register"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("registerUser throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "limit" })),
    );
    await expect(svc.registerUser("x")).rejects.toThrow(/register failed/);
  });

  it("createRoom lazily registers the orchestrator, then creates a room", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: "@orc:localhost", access_token: "o" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: "!r:localhost" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const roomId = await svc.createRoom("Study");
    expect(roomId).toBe("!r:localhost");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("joinRoom POSTs to /join with a bearer token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await svc.joinRoom("tok", "!r:localhost");
    const [url, opts] = (fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toContain("/join/");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok");
  });

  it("joinRoom throws on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "no" })),
    );
    await expect(svc.joinRoom("tok", "!r:localhost")).rejects.toThrow(/join failed/);
  });
});
