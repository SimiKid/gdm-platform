import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@gdm/shared";
import Overview, { SessionsTable } from "./Overview";
import { calledPaths, mockApi, progress, session, sessionSummary } from "../test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("selects the link for a manual copy when the clipboard refuses", async () => {
    const user = userEvent.setup();
    mockApi({});
    render(<Overview rounds={null} rows={[]} sessions={[]} />);
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("button", { name: "Press Ctrl/⌘+C" })).toBeInTheDocument();
    const input = screen.getByDisplayValue("http://localhost:3000/") as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionEnd! - input.selectionStart!).toBe(input.value.length);
  });
});

describe("SessionsTable", () => {
  const detail: Session = session();

  it("expands a session inline on click, refreshes it with the poll, and collapses on a second click", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ [`/admin/sessions/${detail.id}`]: detail });
    const sessions = [
      sessionSummary({ status: "waiting", startedAt: undefined, completedAt: undefined }),
      sessionSummary({ id: "other-session" }),
    ];
    const { rerender } = render(<SessionsTable sessions={sessions} title="E2E Test Sessions" label="E2E" />);

    expect(screen.getByRole("heading", { name: "E2E Test Sessions" })).toBeInTheDocument();
    const list = screen.getByLabelText("E2E");
    expect(list).toHaveClass("compact");
    const row = within(list).getAllByRole("row")[1];
    expect(within(row).getByText("lobby")).toHaveClass("status", "waiting");
    expect(within(row).getAllByText("not yet")).toHaveLength(2);

    await user.click(row);
    const participants = await screen.findByLabelText("Participants");
    // The inspector unfolds directly under the clicked row, above the next
    // session, and the list drops its height cap while it is open.
    const expanded = row.nextElementSibling as HTMLElement;
    expect(expanded).toHaveClass("detail-row");
    expect(expanded).toContainElement(participants);
    expect(expanded.nextElementSibling).toHaveTextContent("other-se");
    expect(list).not.toHaveClass("compact");
    expect(within(participants).getByText("All").nextElementSibling).toHaveTextContent("6 + 1 bot");
    expect(screen.getByText("bot public")).toBeInTheDocument();
    expect(within(participants).getByText("Red")).toBeInTheDocument();
    expect(screen.getByText("Nudges").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Ranking edits").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("!room:localhost")).toBeInTheDocument();
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(row).toHaveClass("selected");

    // A new poll result re-fetches the open detail.
    rerender(<SessionsTable sessions={[...sessions]} title="E2E Test Sessions" label="E2E" />);
    await waitFor(() =>
      expect(calledPaths(fetchMock).filter((p) => p.startsWith("/admin/sessions/")).length).toBeGreaterThanOrEqual(2),
    );

    await user.click(row);
    await waitFor(() => expect(screen.queryByLabelText("Participants")).toBeNull());
    expect(row.nextElementSibling).not.toHaveClass("detail-row");
    expect(list).toHaveClass("compact");
  });

  it("shows a failed detail fetch in the inspector", async () => {
    const user = userEvent.setup();
    mockApi({ "/admin/sessions/x": { status: 404 } });
    render(<SessionsTable sessions={[sessionSummary({ id: "x" })]} />);
    await user.click(screen.getAllByRole("row")[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this session (404).");
    expect(screen.queryByLabelText("Participants")).toBeNull();
  });

  it("reports a network error while loading a session", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    render(<SessionsTable sessions={[sessionSummary({ id: "x" })]} />);
    await user.click(screen.getAllByRole("row")[1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to fetch");
  });

  it("opens and closes a session from the keyboard", async () => {
    const user = userEvent.setup();
    mockApi({ [`/admin/sessions/${detail.id}`]: detail });
    render(<SessionsTable sessions={[sessionSummary()]} />);
    const row = screen.getAllByRole("row")[1];
    expect(row).toHaveAttribute("aria-expanded", "false");
    row.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByLabelText("Participants")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    await waitFor(() => expect(screen.queryByLabelText("Participants")).toBeNull());
    await user.keyboard("{Tab}");
    expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("drops a detail response that arrives after its row was closed or replaced", async () => {
    const user = userEvent.setup();
    // Each request waits until the test releases it, in any order.
    const pending = new Map<string, () => void>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string) => {
        const id = String(input).split("/").pop()!;
        return new Promise((resolve) => {
          pending.set(id, () =>
            resolve({ ok: true, status: 200, json: async () => ({ ...detail, id, roomId: `!room-${id}` }) }),
          );
        });
      }),
    );
    render(<SessionsTable sessions={[sessionSummary({ id: "a" }), sessionSummary({ id: "b" })]} />);
    const [, rowA, rowB] = screen.getAllByRole("row");

    // Open A, close it again, then A's response lands: it must stay closed.
    await user.click(rowA);
    expect(screen.getByText("Loading session…")).toBeInTheDocument();
    await user.click(rowA);
    await act(async () => pending.get("a")!());
    expect(rowA).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Participants")).toBeNull();

    // Open A, switch to B, then A answers late and B afterwards: only B shows.
    await user.click(rowA);
    await user.click(rowB);
    await act(async () => pending.get("a")!());
    expect(screen.queryByText("!room-a")).toBeNull();
    expect(screen.getByText("Loading session…")).toBeInTheDocument();
    await act(async () => pending.get("b")!());
    expect(await screen.findByText("!room-b")).toBeInTheDocument();
    expect(rowB.nextElementSibling).toHaveClass("detail-row");
    expect(screen.queryByText("!room-a")).toBeNull();
  });
});
