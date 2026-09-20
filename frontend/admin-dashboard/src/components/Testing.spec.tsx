import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Testing from "./Testing";
import { mockApi, progress, sessionSummary } from "../test-utils";

afterEach(() => vi.unstubAllGlobals());

describe("Testing", () => {
  it("shows only e2e residue and warns about open test sessions", () => {
    mockApi({});
    render(
      <Testing
        onSaved={vi.fn()}
        rows={[progress({}), progress({ id: "e2e-1", name: "E2E run", active: true })]}
        sessions={[
          sessionSummary({ id: "study" }),
          sessionSummary({ id: "e2e-running", conditionId: "e2e-1", conditionName: "E2E run", status: "running" }),
          sessionSummary({ id: "e2e-done", conditionId: "e2e-1", conditionName: "E2E run" }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Testing Workspace" })).toBeInTheDocument();
    expect(screen.getByText(/1 E2E session is still/)).toBeInTheDocument();
    const table = screen.getByLabelText("E2E test sessions");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).queryByText("Baseline")).toBeNull();
    // Pilot links cover the study arms; the recruiting switch covers only residue.
    const pilots = screen.getByRole("heading", { name: "Pilot Links" }).closest("section")!;
    expect(within(pilots).getByText("Baseline")).toBeInTheDocument();
    const recruiting = screen.getByLabelText("Recruiting");
    expect(within(recruiting).getByText("E2E run")).toBeInTheDocument();
    expect(within(recruiting).queryByText("Baseline")).toBeNull();
    expect(screen.getByText(/1 test condition is still active/)).toBeInTheDocument();
  });

  it("lets test conditions be switched off but never on or edited", async () => {
    const user = userEvent.setup();
    const puts: Array<{ condition: { id: string; active: boolean } }> = [];
    mockApi({
      "/conditions/e2e-on": (init: RequestInit | undefined) => {
        puts.push(JSON.parse(String(init?.body)));
        return { ok: true };
      },
    });
    const onSaved = vi.fn();
    render(
      <Testing
        onSaved={onSaved}
        rows={[
          progress({ id: "e2e-on", name: "E2E on", active: true }),
          progress({ id: "e2e-off", name: "E2E off", active: false }),
        ]}
        sessions={[]}
      />,
    );
    const onSwitch = screen.getByRole("checkbox", { name: "E2E on recruiting" });
    const offSwitch = screen.getByRole("checkbox", { name: "E2E off recruiting" });
    expect(onSwitch).toBeEnabled();
    expect(offSwitch).toBeDisabled();
    expect(offSwitch.closest("label")).toHaveAttribute("title", expect.stringMatching(/cannot be switched on/));
    expect(screen.getByRole("spinbutton", { name: "E2E on goal" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    await user.click(onSwitch);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts.map((p) => p.condition)).toEqual([
      expect.objectContaining({ id: "e2e-on", active: false }),
    ]);
  });

  it("shows the empty state without residue", () => {
    mockApi({});
    render(<Testing onSaved={vi.fn()} rows={[progress({})]} sessions={[]} />);
    expect(screen.getByText("No E2E test sessions yet.")).toBeInTheDocument();
    expect(screen.queryByText(/still/)).toBeNull();
  });
});
