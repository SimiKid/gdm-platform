import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { httpSessionManager } from "./sessionClient";

beforeEach(() => sessionStorage.setItem("gdm-tracking-token", "participant-token"));
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function okJson(value: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => value,
    text: async () => JSON.stringify(value),
  }));
}

describe("httpSessionManager", () => {
  it("records a Prolific arrival immediately", async () => {
    const prolific = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    vi.stubGlobal("fetch", okJson({ ...prolific, arrivedAt: "now" }));
    await expect(
      httpSessionManager.recordProlificArrival(prolific),
    ).resolves.toMatchObject(prolific);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/prolific/arrivals"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("requests a server-side Prolific resume", async () => {
    const prolific = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    vi.stubGlobal("fetch", okJson(null));
    await expect(httpSessionManager.resumeProlific(prolific)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/prolific/resume"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("treats an empty successful resume response as no existing session", async () => {
    const prolific = {
      participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "cccccccccccccccccccccccc",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 201, text: async () => "" })),
    );

    await expect(httpSessionManager.resumeProlific(prolific)).resolves.toBeNull();
  });

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
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/s"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer participant-token",
        }),
      }),
    );
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

  it("completes one participant and returns the compensation URL", async () => {
    vi.stubGlobal(
      "fetch",
      okJson({ completedAt: "now", compensationUrl: "https://pay.example" }),
    );
    await expect(
      httpSessionManager.completeParticipant("s", "p"),
    ).resolves.toMatchObject({ compensationUrl: "https://pay.example" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/sessions/s/participants/p/complete"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("httpSessionManager – Prolific lifecycle and error paths", () => {
  const prolific = {
    participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId: "cccccccccccccccccccccccc",
  };

  it("records participation progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await httpSessionManager.recordParticipationProgress(prolific, "waiting");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/prolific/progress"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prolific, stage: "waiting" }),
      }),
    );
  });

  it("terminates participation and returns the outcome", async () => {
    const outcome = { outcome: "declined_consent", compensationKind: "none", redirectUrl: "", message: "" };
    vi.stubGlobal("fetch", okJson(outcome));
    await expect(
      httpSessionManager.terminateParticipation(prolific, "declined_consent", "no consent"),
    ).resolves.toEqual(outcome);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/prolific/terminate"),
      expect.objectContaining({
        body: JSON.stringify({ prolific, outcome: "declined_consent", reason: "no consent" }),
      }),
    );
  });

  it("reads the participation outcome, treating an empty body as none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "  " })));
    await expect(httpSessionManager.getParticipationOutcome(prolific)).resolves.toBeNull();

    const outcome = { outcome: "unmatched", compensationKind: "partial" };
    vi.stubGlobal("fetch", okJson(outcome));
    await expect(httpSessionManager.getParticipationOutcome(prolific)).resolves.toEqual(outcome);
  });

  it("submits debrief feedback with the participant token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
    await httpSessionManager.submitDebriefFeedback("s", "p", "great study");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/surveys/debrief-feedback"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer participant-token" }),
        body: JSON.stringify({ sessionId: "s", participantId: "p", feedback: "great study" }),
      }),
    );
  });

  it("omits the Authorization header when no participant token is stored", async () => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", okJson({ id: "s" }));
    await httpSessionManager.getSession("s");
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it.each([
    ["recordProlificArrival", () => httpSessionManager.recordProlificArrival(prolific)],
    ["resumeProlific", () => httpSessionManager.resumeProlific(prolific)],
    ["recordParticipationProgress", () => httpSessionManager.recordParticipationProgress(prolific, "consent")],
    ["terminateParticipation", () => httpSessionManager.terminateParticipation(prolific, "ineligible")],
    ["getParticipationOutcome", () => httpSessionManager.getParticipationOutcome(prolific)],
    ["getSession", () => httpSessionManager.getSession("s")],
    ["submitSurvey", () => httpSessionManager.submitSurvey({ sessionId: "s", participantId: "p", kind: "exit", survey: { answers: {}, submittedAt: "" } })],
    ["submitDebriefFeedback", () => httpSessionManager.submitDebriefFeedback("s", "p", "x")],
    ["completeParticipant", () => httpSessionManager.completeParticipant("s", "p")],
  ])("%s rejects with the HTTP status on a non-ok response", async (name, call) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    await expect(call()).rejects.toThrow(new RegExp(`${name} failed: 503`));
  });
});
