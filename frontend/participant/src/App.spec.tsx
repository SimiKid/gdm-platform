import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const client = vi.hoisted(() => ({
  resumeProlific: vi.fn(),
  recordProlificArrival: vi.fn(),
  recordParticipationProgress: vi.fn(async () => undefined),
  getParticipationOutcome: vi.fn(async () => null),
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
