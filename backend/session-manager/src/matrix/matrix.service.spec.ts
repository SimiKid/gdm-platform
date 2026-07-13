import { describe, it, expect, beforeEach, vi } from "vitest";
import { MatrixService } from "./matrix.service";

/**
 * Behavior-level tests only: credential mapping, orchestrator caching and
 * error propagation. The actual wire format is exercised against a real
 * Synapse by the e2e stack (and the chat-service integration suite covers
 * the same client-server API), so no URL/header assertions here.
 */
describe("MatrixService", () => {
  let svc: MatrixService;
  beforeEach(() => {
    svc = new MatrixService();
  });

  it("registerUser returns the homeserver's credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ user_id: "@x:localhost", access_token: "tok" }),
      })),
    );
    const creds = await svc.registerUser("gdm");
    expect(creds).toEqual({ userId: "@x:localhost", accessToken: "tok" });
  });

  it("registerUser throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "limit" })),
    );
    await expect(svc.registerUser("x")).rejects.toThrow(/register failed/);
  });

  it("createRoom logs in the stable orchestrator once and reuses it", async () => {
    const fetchMock = vi
      .fn()
      // 1st createRoom: orchestrator login + room creation…
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: "@orc:localhost", access_token: "o" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: "!r1:localhost" }),
      })
      // …2nd createRoom: room creation only.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: "!r2:localhost" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    expect(await svc.createRoom("Study 1")).toBe("!r1:localhost");
    expect(await svc.createRoom("Study 2")).toBe("!r2:localhost");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({
      preset: "private_chat",
      visibility: "private",
      power_level_content_override: { invite: 100 },
    });
  });

  it("registers the stable orchestrator when its first login is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ user_id: "@gdm_orchestrator:localhost", access_token: "o" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ room_id: "!r:localhost" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(svc.createRoom("Study")).resolves.toBe("!r:localhost");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("createRoom throws on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    await expect(svc.createRoom("Study")).rejects.toThrow(/failed/);
  });

  it("joinRoom throws on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "no" })),
    );
    await expect(svc.joinRoom("tok", "!r:localhost")).rejects.toThrow(/join failed/);
  });
});
