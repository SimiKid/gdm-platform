import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const client = vi.hoisted(() => ({
  resumeProlific: vi.fn(),
  recordProlificArrival: vi.fn(),
  recordParticipationProgress: vi.fn(async () => undefined),
  getParticipationOutcome: vi.fn(async () => null),
  completeParticipant: vi.fn(async () => ({
    completedAt: "2026-09-29T10:00:00.000Z",
    compensationUrl: "",
  })),
  submitDebriefFeedback: vi.fn(async () => undefined),
}));

vi.mock("./study/sessionClient", () => ({
  httpSessionManager: client,
}));

import App from "./App";

describe("App Prolific resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState(
      {},
      "",
      "/?PROLIFIC_PID=aaaaaaaaaaaaaaaaaaaaaaaa&STUDY_ID=bbbbbbbbbbbbbbbbbbbbbbbb&SESSION_ID=cccccccccccccccccccccccc",
    );
  });

  it("shows an existing terminal outcome before attempting a new arrival", async () => {
    client.resumeProlific.mockResolvedValueOnce({
      stage: "terminated",
      termination: {
        outcome: "connection_timeout",
        compensationKind: "partial",
        compensationAmountPence: 100,
        redirectUrl: "https://app.prolific.com/submissions/complete?cc=TECHNICAL",
        message: "The reconnect window expired.",
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Your participation has ended" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(client.resumeProlific).toHaveBeenCalledOnce());
    expect(client.recordProlificArrival).not.toHaveBeenCalled();
    expect(screen.getByText(/What this study was investigating/)).toBeInTheDocument();
  });
});

describe("App refresh on the debrief page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("keeps the saved session id so the debrief feedback is attributed", async () => {
    sessionStorage.setItem(
      "gdm-study-progress",
      JSON.stringify({
        stage: "done",
        sessionId: "session-1",
        participantId: "participant-1",
        matrix: {
          homeserverUrl: "http://matrix.test",
          userId: "@p:test",
          accessToken: "token",
          roomId: "!room:test",
        },
      }),
    );

    render(<App />);

    const feedback = await screen.findByPlaceholderText("Optional feedback…");
    expect(client.completeParticipant).toHaveBeenCalledWith(
      "session-1",
      "participant-1",
    );
    await userEvent.type(feedback, "Interesting study");
    await userEvent.click(screen.getByRole("button", { name: "Finish study" }));

    expect(client.submitDebriefFeedback).toHaveBeenCalledWith(
      "session-1",
      "participant-1",
      "Interesting study",
    );
  });
});
