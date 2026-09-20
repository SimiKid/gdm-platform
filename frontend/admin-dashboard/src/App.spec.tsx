import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { calledPaths, mockApi, progress, sessionSummary } from "./test-utils";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const rounds = {
  currentRound: 1,
  rounds: [{ number: 1, label: "", startedAt: "2026-09-01T00:00:00Z", sessionCount: 0, completedCount: 0 }],
};

function dashboardApi(extra: Record<string, unknown> = {}) {
  return mockApi({
    "/conditions/progress": [progress({}, 1)],
    "/sessions": [sessionSummary({ status: "waiting" })],
    "/rounds": rounds,
    "/admin/etherpad": { enabled: false, state: "stopped" },
    "/settings": {
      compensationUrl: "https://app.prolific.com/submissions/complete?cc=DONE",
      noConsentUrl: "",
      ineligibleUrl: "",
      withdrawalUrl: "",
      unmatchedUrl: "",
      technicalFailureUrl: "",
    },
    ...extra,
  });
}

describe("App", () => {
  it("loads the dashboard and switches between views", async () => {
    const user = userEvent.setup();
    const fetchMock = dashboardApi();
    render(<App />);

    expect((await screen.findAllByText("Baseline")).length).toBeGreaterThan(0);
    expect(calledPaths(fetchMock)).toEqual(
      expect.arrayContaining(["/conditions/progress", "/sessions", "/rounds", "/admin/etherpad"]),
    );
    expect(calledPaths(fetchMock)).not.toContain("/admin/prolific/outcomes");

    // The dashboard has exactly three views; Results and Prolific were removed.
    expect(screen.queryByRole("button", { name: "Results" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prolific" })).toBeNull();
    expect(within(screen.getByRole("navigation", { name: "Views" })).getAllByRole("button")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Study Rounds" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Testing" }));
    expect(screen.getByRole("heading", { name: "Testing Workspace" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByText("Study Link")).toBeInTheDocument();
  });

  it("gates the dashboard behind the admin token when the backend answers 401", async () => {
    const user = userEvent.setup();
    const fetchMock = dashboardApi({ "/conditions/progress": { status: 401 } });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Admin token" })).toBeInTheDocument();
    fetchMock.mockClear();
    // Once a token is entered the backend accepts the requests.
    dashboardApi();
    await user.type(screen.getByLabelText("Admin token"), "  secret  ");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("Study Link")).toBeInTheDocument();
    expect(localStorage.getItem("gdm-admin-token")).toBe("secret");
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer secret");
  });

  it("surfaces a load failure without hiding the dashboard", async () => {
    dashboardApi({ "/sessions": { status: 503 } });
    render(<App />);
    expect(await screen.findByText("Could not load sessions (503)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Study Admin" })).toBeInTheDocument();
  });

  it("tolerates a missing Etherpad status endpoint", async () => {
    dashboardApi({ "/admin/etherpad": { status: 500 } });
    render(<App />);
    expect((await screen.findAllByText("Baseline")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByText(/Could not load/)).toBeNull());
  });
});
