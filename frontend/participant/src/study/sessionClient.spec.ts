import { describe, it, expect, vi, afterEach } from "vitest";
import { httpSessionManager } from "./sessionClient";

afterEach(() => vi.unstubAllGlobals());

function okJson(value: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => value }));
}

describe("httpSessionManager", () => {
  it("openSession POSTs and returns the response", async () => {
    vi.stubGlobal("fetch", okJson({ session: { id: "s" } }));
    const res = await httpSessionManager.openSession({
      trackingToken: "t",
      participantName: "",
    });
    expect(res.session.id).toBe("s");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("openSession throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(
      httpSessionManager.openSession({ trackingToken: "t", participantName: "" }),
    ).rejects.toThrow(/openSession failed/);
  });

  it("getSession GETs a session by id", async () => {
    vi.stubGlobal("fetch", okJson({ id: "s" }));
    const session = await httpSessionManager.getSession("s");
    expect(session.id).toBe("s");
  });

  it("submitSurvey POSTs to /surveys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await httpSessionManager.submitSurvey({
      sessionId: "s",
      participantId: "p",
      kind: "entry",
      survey: { answers: {}, submittedAt: "" },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/surveys"),
      expect.any(Object),
    );
  });

  it("completeSession POSTs to /complete", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await httpSessionManager.completeSession("s");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/s/complete"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("completeSession throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(httpSessionManager.completeSession("s")).rejects.toThrow(
      /completeSession failed/,
    );
  });
});
