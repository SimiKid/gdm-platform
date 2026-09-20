import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionReportSummary, RoundsResponse } from "@gdm/shared";
import Results from "./Results";
import { API_BASE } from "../api";
import { calledPaths, mockApi } from "../test-utils";

function row(overrides: Partial<ConditionReportSummary>): ConditionReportSummary {
  return {
    conditionId: "baseline",
    conditionName: "Baseline",
    interventionMode: "baseline",
    llmMode: "off",
    sessionsCompleted: 4,
    sessionsAborted: 0,
    sessionsRunning: 0,
    participants: 12,
    entrySurveys: 12,
    exitSurveys: 11,
    meanGroupRankingError: 31.456,
    meanIndividualRankingError: 40,
    meanExitRankingError: 35,
    meanSatisfaction: 4.1,
    meanFairness: null,
    meanFeltHeard: 3.999,
    meanShareStdDev: 0.123456,
    meanShareGini: 0.2,
    nudgesTotal: 3,
    nudgesPerSessionMean: 0.75,
    windowsEvaluated: 40,
    windowsNudged: 3,
    ...overrides,
  };
}

const twoRounds: RoundsResponse = {
  currentRound: 2,
  rounds: [
    { number: 1, label: "pilot", startedAt: "2026-08-01T00:00:00Z", endedAt: "2026-09-01T00:00:00Z", sessionCount: 4, completedCount: 4 },
    { number: 2, label: "", startedAt: "2026-09-01T00:00:00Z", sessionCount: 1, completedCount: 0 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("Results", () => {
  it("renders per-condition descriptives, hides e2e residue and formats numbers", async () => {
    mockApi({
      "/reports/summary": {
        generatedAt: "now",
        conditions: [
          row({}),
          row({ conditionId: "public-llm", conditionName: "Public", sessionsRunning: 1, meanSatisfaction: null }),
          row({ conditionId: "e2e-123", conditionName: "E2E residue" }),
        ],
      },
    });
    render(<Results rounds={{ currentRound: 1, rounds: [twoRounds.rounds[1]] }} />);

    const baseline = (await screen.findByText("Baseline")).closest("tr")!;
    const table = baseline.closest("table")!;
    expect(within(baseline).getByText("31.46")).toBeInTheDocument();
    expect(within(baseline).getByText("n/a")).toBeInTheDocument();
    expect(within(baseline).getByText("12/11")).toBeInTheDocument();
    expect(within(baseline).getByText("40 (3)")).toBeInTheDocument();
    expect(within(table).getByText("(+1 live)")).toBeInTheDocument();
    expect(screen.queryByText("E2E residue")).toBeNull();
    // A single-round study shows no round filter.
    expect(screen.queryByRole("group", { name: "Round filter" })).toBeNull();
    expect(screen.getByText(/Showing all rounds\./)).toBeInTheDocument();
  });

  it("filters the summary and every download by the selected rounds", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      "/reports/summary": { generatedAt: "now", conditions: [row({})] },
    });
    render(<Results rounds={twoRounds} />);
    await screen.findByRole("table");

    const filter = screen.getByRole("group", { name: "Round filter" });
    await user.click(within(filter).getByRole("button", { name: "Round 2" }));
    await waitFor(() =>
      expect(calledPaths(fetchMock)).toContain("/reports/summary?roundIds=2"),
    );
    expect(screen.getByText(/Showing Round 2\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Research Bundle/ })).toHaveAttribute(
      "href",
      `${API_BASE}/export/research.zip?roundIds=2`,
    );
    expect(screen.getByRole("link", { name: /Linkage/ })).toHaveAttribute(
      "href",
      `${API_BASE}/export/linkage.csv?roundIds=2`,
    );

    await user.click(within(filter).getByRole("button", { name: "Round 1 (pilot)" }));
    await waitFor(() =>
      expect(calledPaths(fetchMock)).toContain("/reports/summary?roundIds=1,2"),
    );
    expect(screen.getByText(/Showing Rounds 1, 2\./)).toBeInTheDocument();

    // Toggling a selected round off again removes it.
    await user.click(within(filter).getByRole("button", { name: "Round 2" }));
    await waitFor(() =>
      expect(calledPaths(fetchMock)).toContain("/reports/summary?roundIds=1"),
    );

    await user.click(within(filter).getByRole("button", { name: "All rounds" }));
    await waitFor(() => expect(screen.getByText(/Showing all rounds\./)).toBeInTheDocument());
    expect(within(filter).getByRole("button", { name: "All rounds" })).toHaveClass("active");
  });

  it("lists the individual research datasets as JSON and CSV links", async () => {
    mockApi({ "/reports/summary": { generatedAt: "now", conditions: [] } });
    render(<Results rounds={null} />);
    expect(await screen.findByText("No study sessions yet.")).toBeInTheDocument();
    const datasets = screen.getByText("Individual research datasets").closest("details")!;
    const links = within(datasets).getAllByRole("link");
    expect(links).toHaveLength(10);
    expect(links.map((link) => link.getAttribute("href"))).toContain(
      `${API_BASE}/export/windows.csv`,
    );
    // Saved under the server's own filenames (underscore, not the URL slug).
    expect(links.map((link) => link.getAttribute("download"))).toEqual([
      "participants.json",
      "participants.csv",
      "sessions_analysis.json",
      "sessions_analysis.csv",
      "windows.json",
      "windows.csv",
      "rankings.json",
      "rankings.csv",
      "etherpad.json",
      "etherpad.csv",
    ]);
  });

  it("shows the load error and refetches on Refresh", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ "/reports/summary": { status: 500 } });
    render(<Results rounds={null} />);
    expect(await screen.findByText("Could not load results (500)")).toBeInTheDocument();

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ generatedAt: "now", conditions: [row({})] }),
      text: async () => "",
      blob: async () => new Blob(),
    }));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Baseline")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load results/)).toBeNull();
  });
});
