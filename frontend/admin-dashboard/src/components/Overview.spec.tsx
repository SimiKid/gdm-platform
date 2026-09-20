import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@gdm/shared";
import Overview, { SessionsTable } from "./Overview";
import { calledPaths, mockApi, progress, sessionSummary } from "../test-utils";

afterEach(() => vi.unstubAllGlobals());

const rounds = {
  currentRound: 2,
  rounds: [
    { number: 1, label: "", startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-09-01T00:00:00Z", sessionCount: 3, completedCount: 3 },
    { number: 2, label: "demo", startedAt: "2026-09-01T00:00:00Z", sessionCount: 2, completedCount: 1 },
  ],
};

describe("Overview", () => {
  it("summarises the study arms and keeps e2e residue out of every number", () => {
    mockApi({});
    render(
      <Overview
        rounds={rounds}
        rows={[
          progress({}, 2),
          progress({ id: "public-llm", name: "Public", goal: 5 }, 1),
          progress({ id: "e2e-1", name: "E2E", goal: 1 }, 1),
        ]}
        sessions={[
          sessionSummary({ id: "s-running", status: "running" }),
          sessionSummary({ id: "s-waiting", status: "waiting" }),
          sessionSummary({ id: "s-done" }),
          sessionSummary({ id: "s-e2e", status: "running", conditionId: "e2e-1" }),
        ]}
      />,
    );
    const metric = (label: string) =>
      screen.getByText(label, { exact: false }).closest("div")!.querySelector("strong")!.textContent;
    expect(metric("Current round (demo)")).toBe("Round 2");
    expect(metric("Completed sessions (round)")).toBe("3 / 10");
    expect(metric("Active now")).toBe("1");
    expect(screen.getByLabelText("live")).toBeInTheDocument();
    expect(metric("In lobby")).toBe("1");
    expect(metric("Sessions total")).toBe("3");

    const tracking = screen
      .getByRole("heading", { name: "Completed per Condition (current round)" })
      .closest("section")!;
    expect(within(tracking).getByText("Baseline")).toBeInTheDocument();
    expect(within(tracking).getByText("Public")).toBeInTheDocument();
    expect(within(tracking).getByText("3 remaining")).toBeInTheDocument();
    expect(within(tracking).getByText("4 remaining")).toBeInTheDocument();
    expect(screen.queryByText("E2E")).toBeNull();
    expect(within(screen.getByLabelText("Sessions")).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByDisplayValue("http://localhost:3000/")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Research Data (CSV)" })).toHaveAttribute("download", "research_data.zip");
    expect(screen.getByRole("link", { name: "JSON" })).toHaveAttribute("download", "detailed_data.json");
  });

  it("copies the study link to the clipboard", async () => {
    const user = userEvent.setup();
    mockApi({});
    render(<Overview rounds={null} rows={[]} sessions={[]} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Copied ✓" })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("http://localhost:3000/");
    expect(screen.queryByText(/Current round/)).toBeNull();
    expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
  });
});

describe("SessionsTable", () => {
  const detail = {
    id: "11112222-3333-4444-5555-666677778888",
    roomId: "!room:localhost",
    condition: { id: "baseline", name: "Baseline", config: { interventionMode: "public" } },
    participants: [
      { name: "", trackingToken: "tok-abcdefgh-rest" },
      { name: "Alice", trackingToken: "tok-2" },
    ],
    chat: { messages: [{ text: "hi" }, { text: "there" }] },
    interventions: [{}],
    behavioralEvents: [{}, {}, {}],
    contributionClassifications: [],
    rankingHistory: undefined,
  } as unknown as Session;

  it("opens a session inspector on click, refreshes it with the poll, and closes on a second click", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ [`/admin/sessions/${detail.id}`]: detail });
    const sessions = [sessionSummary({ status: "waiting", startedAt: undefined, completedAt: undefined })];
    const { rerender } = render(<SessionsTable sessions={sessions} title="E2E Test Sessions" label="E2E" />);

    expect(screen.getByRole("heading", { name: "E2E Test Sessions" })).toBeInTheDocument();
    const row = within(screen.getByLabelText("E2E")).getAllByRole("row")[1];
    expect(within(row).getByText("lobby")).toHaveClass("status", "waiting");
    expect(within(row).getAllByText("not yet")).toHaveLength(2);

    await user.click(row);
    const facts = await screen.findByText("Bot mode");
    expect(facts.nextElementSibling).toHaveTextContent("public");
    expect(screen.getByText("Participants").nextElementSibling).toHaveTextContent("tok-abcd, Alice");
    expect(screen.getByText("Messages").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Nudges").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Behavior events").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("Ranking edits").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Room").nextElementSibling).toHaveTextContent("!room:localhost");
    expect(row).toHaveClass("selected");

    // A new poll result re-fetches the open detail.
    rerender(<SessionsTable sessions={[...sessions]} title="E2E Test Sessions" label="E2E" />);
    await waitFor(() =>
      expect(calledPaths(fetchMock).filter((p) => p.startsWith("/admin/sessions/")).length).toBeGreaterThanOrEqual(2),
    );

    await user.click(within(screen.getByLabelText("E2E")).getAllByRole("row")[1]);
    await waitFor(() => expect(screen.queryByText("Bot mode")).toBeNull());
  });

  it("ignores a failed detail fetch", async () => {
    const user = userEvent.setup();
    mockApi({ "/admin/sessions/x": { status: 404 } });
    render(<SessionsTable sessions={[sessionSummary({ id: "x" })]} />);
    await user.click(screen.getAllByRole("row")[1]);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("Bot mode")).toBeNull();
  });
});
