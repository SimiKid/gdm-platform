import { render, screen, within } from "@testing-library/react";
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

  it("shows the empty state without residue", () => {
    mockApi({});
    render(<Testing onSaved={vi.fn()} rows={[progress({})]} sessions={[]} />);
    expect(screen.getByText("No E2E test sessions yet.")).toBeInTheDocument();
    expect(screen.queryByText(/still/)).toBeNull();
  });
});
