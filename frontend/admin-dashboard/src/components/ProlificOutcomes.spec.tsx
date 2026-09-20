import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParticipationOutcomeRecord } from "@gdm/shared";
import ProlificOutcomes from "./ProlificOutcomes";
import { calledPaths, mockApi } from "../test-utils";

function outcome(overrides: Partial<ParticipationOutcomeRecord>): ParticipationOutcomeRecord {
  return {
    id: "arrival-1",
    participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId: "cccccccc-rest-of-the-submission",
    arrivedAt: "2026-09-01T10:00:00Z",
    stage: "terminated",
    stageUpdatedAt: "2026-09-01T10:05:00Z",
    lastSeenAt: "2026-09-01T10:05:00Z",
    outcome: "unmatched",
    outcomeReason: "group did not form",
    elapsedSeconds: 65,
    compensationKind: "partial",
    compensationAmountPence: 125,
    prolificActionStatus: "pending",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProlificOutcomes", () => {
  it("shows an empty hint without arrivals", () => {
    render(<ProlificOutcomes outcomes={[]} onChanged={vi.fn()} />);
    expect(screen.getByText("No Prolific arrivals yet.")).toBeInTheDocument();
  });

  it("renders each outcome with the actions its state allows", () => {
    render(
      <ProlificOutcomes
        onChanged={vi.fn()}
        outcomes={[
          outcome({}),
          outcome({ id: "arrival-2", returnRequestedAt: "x", bonusBatchId: "b", prolificActionStatus: "bonus_prepared" }),
          outcome({ id: "arrival-3", returnRequestedAt: "x", bonusBatchId: "b", paymentSubmittedAt: "y", prolificActionStatus: "payment_submitted" }),
          outcome({ id: "arrival-4", compensationKind: "none", returnRequestedAt: "x", prolificActionStatus: "resolved_manually", actionError: "verify in Prolific" }),
          outcome({ id: "arrival-5", outcome: "completed", stage: "done", compensationKind: "full", compensationAmountPence: undefined, elapsedSeconds: undefined }),
          outcome({ id: "arrival-6", outcome: undefined, stage: "chat", compensationKind: undefined, prolificActionStatus: undefined }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    const names = (row: HTMLElement) =>
      within(row).queryAllByRole("button").map((b) => b.textContent);

    expect(within(rows[0]).getByText("cccccccc")).toHaveAttribute("title", expect.stringContaining("submission"));
    expect(within(rows[0]).getByText("1m 5s")).toBeInTheDocument();
    expect(within(rows[0]).getByText("£1.25")).toBeInTheDocument();
    expect(within(rows[0]).getByText("group did not form")).toBeInTheDocument();
    expect(names(rows[0])).toEqual(["Request return", "Prepare bonus", "Resolve manually"]);
    expect(names(rows[1])).toEqual(["Pay bonus", "Resolve manually"]);
    expect(names(rows[2])).toEqual([]);
    expect(names(rows[3])).toEqual([]);
    expect(within(rows[3]).getByText("verify in Prolific")).toBeInTheDocument();
    expect(names(rows[4])).toEqual([]);
    expect(within(rows[4]).getByText("—")).toBeInTheDocument();
    expect(within(rows[5]).getByText("chat")).toBeInTheDocument();
  });

  it("asks before requesting a return and does nothing when declined", async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({});
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<ProlificOutcomes outcomes={[outcome({})]} onChanged={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Request return" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the confirmed action and refreshes the dashboard", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const fetchMock = mockApi({ "/admin/prolific/outcomes/arrival-2/actions/pay-bonus": {} });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ProlificOutcomes
        onChanged={onChanged}
        outcomes={[outcome({ id: "arrival-2", returnRequestedAt: "x", bonusBatchId: "b", prolificActionStatus: "bonus_prepared" })]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pay bonus" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/cannot be undone/));
    expect(calledPaths(fetchMock)).toEqual(["/admin/prolific/outcomes/arrival-2/actions/pay-bonus"]);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("POST");
  });

  it("shows the failure and keeps the buttons usable when the action fails", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    mockApi({ "/admin/prolific/outcomes/arrival-1/actions/resolve-manually": { status: 409 } });
    render(<ProlificOutcomes outcomes={[outcome({})]} onChanged={onChanged} />);
    await user.click(screen.getByRole("button", { name: "Resolve manually" }));
    expect(await screen.findByText("Action failed (409)")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Resolve manually" })).toBeEnabled();
  });

  it("disables every action while one is running", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true }); })),
    );
    render(<ProlificOutcomes outcomes={[outcome({})]} onChanged={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Prepare bonus" }));
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Request return" })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare bonus" })).toBeEnabled());
  });
});
