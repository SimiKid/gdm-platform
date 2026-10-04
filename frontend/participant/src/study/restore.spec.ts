import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "matrix-js-sdk";
import type { PublicSession } from "@gdm/shared";

const api = vi.hoisted(() => ({
  resumeProlific: vi.fn(),
  getParticipationOutcome: vi.fn(),
  completeParticipant: vi.fn(),
  getSession: vi.fn(),
}));
const matrix = vi.hoisted(() => ({ startMatrixClient: vi.fn() }));

vi.mock("./sessionClient", () => ({ httpSessionManager: api }));
vi.mock("./matrixClient", () => matrix);

import { restoreFromProgress, restoreProlificSeat } from "./restore";
import { loadProgress } from "./progress";
import type { StudyProgress } from "./progress";

const prolific = {
  participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  sessionId: "cccccccccccccccccccccccc",
};
const credentials = {
  homeserverUrl: "http://matrix.test",
  userId: "@p:test",
  accessToken: "token",
  roomId: "!room:test",
};
const session = {
  id: "session-1",
  ranking: { order: ["a", "b"] },
} as unknown as PublicSession;
const fakeClient = { id: "client" } as unknown as MatrixClient;
const termination = {
  outcome: "voluntary_withdrawal" as const,
  compensationKind: "manual_review" as const,
  redirectUrl: "",
  message: "Withdrawn.",
};

function progress(stage: StudyProgress["stage"]): StudyProgress {
  return {
    stage,
    sessionId: "session-1",
    participantId: "participant-1",
    matrix: credentials,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  matrix.startMatrixClient.mockResolvedValue(fakeClient);
  api.getSession.mockResolvedValue(session);
});

describe("restoreProlificSeat", () => {
  function resumeAt(stage: string) {
    api.resumeProlific.mockResolvedValueOnce({
      stage,
      openSession: { session, participantId: "participant-1", matrix: credentials },
    });
  }

  it("returns null for a new visit and the outcome for a terminated one", async () => {
    api.resumeProlific.mockResolvedValueOnce(null);
    await expect(restoreProlificSeat(prolific)).resolves.toBeNull();

    api.resumeProlific.mockResolvedValueOnce({ stage: "terminated", termination });
    await expect(restoreProlificSeat(prolific)).resolves.toEqual({
      stage: "terminated",
      termination,
    });
  });

  it("rejects a resumable stage without a seat", async () => {
    api.resumeProlific.mockResolvedValueOnce({ stage: "chat" });
    await expect(restoreProlificSeat(prolific)).rejects.toThrow(/could not be resumed/);
  });

  it("restores the waiting room and persists the progress", async () => {
    resumeAt("waiting");
    await expect(restoreProlificSeat(prolific)).resolves.toMatchObject({
      stage: "waiting",
      session,
      participantId: "participant-1",
    });
    expect(loadProgress()?.stage).toBe("waiting");
  });

  it("reconnects Matrix for the chat", async () => {
    resumeAt("chat");
    await expect(restoreProlificSeat(prolific)).resolves.toMatchObject({
      stage: "chat",
      client: fakeClient,
    });
    expect(matrix.startMatrixClient).toHaveBeenCalledWith(credentials);
    expect(loadProgress()?.stage).toBe("chat");
  });

  it("restores the exit survey with the group ranking", async () => {
    resumeAt("exit");
    await expect(restoreProlificSeat(prolific)).resolves.toMatchObject({
      stage: "exit",
      groupRanking: ["a", "b"],
    });
  });

  it("re-fetches the completion link for a finished participant", async () => {
    resumeAt("done");
    api.completeParticipant.mockResolvedValueOnce({ compensationUrl: "https://done" });
    await expect(restoreProlificSeat(prolific)).resolves.toMatchObject({
      stage: "done",
      sessionId: "session-1",
      compensationUrl: "https://done",
    });
    expect(loadProgress()?.stage).toBe("done");
  });
});

describe("restoreFromProgress", () => {
  it("shows a server-recorded termination before resuming", async () => {
    api.getParticipationOutcome.mockResolvedValueOnce(termination);
    await expect(restoreFromProgress(progress("chat"), prolific)).resolves.toEqual({
      stage: "terminated",
      termination,
    });
    expect(matrix.startMatrixClient).not.toHaveBeenCalled();
  });

  it("keeps the ids for the done page even when the completion link fails", async () => {
    api.completeParticipant.mockRejectedValueOnce(new Error("offline"));
    await expect(restoreFromProgress(progress("done"), undefined)).resolves.toEqual({
      stage: "done",
      sessionId: "session-1",
      participantId: "participant-1",
    });
  });

  it("returns to the waiting room only with a stored tracking token", async () => {
    await expect(restoreFromProgress(progress("waiting"), undefined)).resolves.toEqual({
      stage: "recruiting",
    });
    sessionStorage.setItem("gdm-tracking-token", "token-1");
    await expect(restoreFromProgress(progress("waiting"), undefined)).resolves.toEqual({
      stage: "waiting",
      trackingToken: "token-1",
    });
  });

  it("refreshes the session for the exit survey and the chat", async () => {
    api.getParticipationOutcome.mockResolvedValueOnce(null);
    await expect(restoreFromProgress(progress("exit"), prolific)).resolves.toMatchObject({
      stage: "exit",
      session,
      groupRanking: ["a", "b"],
    });
    await expect(restoreFromProgress(progress("chat"), undefined)).resolves.toMatchObject({
      stage: "chat",
      session,
      client: fakeClient,
    });
    expect(matrix.startMatrixClient).toHaveBeenCalledWith(credentials);
  });
});
