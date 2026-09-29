import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConditionProgress } from "@gdm/shared";
import Testing from "./Testing";
import { mockApi, progress, sessionSummary } from "../test-utils";

afterEach(() => vi.unstubAllGlobals());

/** A test-condition progress row with a creation time. */
function testRow(id: string, createdAt: string, active = false) {
  return { ...progress({ id, name: `E2E ${id}`, active }), createdAt };
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  const toggle = screen.getByRole("button", { name: "Show test history" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(screen.getByRole("button", { name: "Hide test history" })).toHaveAttribute("aria-expanded", "true");
}

describe("Testing", () => {
  it("puts pilot links first, sums up e2e residue and keeps the history one click away", async () => {
    const user = userEvent.setup();
    mockApi({});
    render(
      <Testing
        onSaved={vi.fn()}
        rows={[
          progress({}),
          { ...progress({ id: "e2e-1", name: "E2E run", active: true }), createdAt: "2026-09-20T10:03:00.000Z" },
        ]}
        sessions={[
          sessionSummary({ id: "study" }),
          sessionSummary({ id: "e2e-done", conditionId: "e2e-1", conditionName: "E2E run" }),
          sessionSummary({ id: "e2e-running", conditionId: "e2e-1", conditionName: "E2E run", status: "running" }),
        ]}
      />,
    );
    const warning = screen.getByLabelText("Active test conditions");
    expect(within(warning).getByText(/1 automated test condition is still recruiting/)).toBeInTheDocument();
    expect(within(warning).getByText("E2E run")).toBeInTheDocument();
    expect(within(warning).getByRole("button", { name: "Switch off E2E run" })).toBeInTheDocument();
    // One condition: no bulk button.
    expect(within(warning).queryByRole("button", { name: /Switch off all/ })).toBeNull();

    // Pilot links cover the study arms only.
    const pilots = screen.getByRole("heading", { name: "Pilot Links" }).closest("section")!;
    expect(within(pilots).getByText("Baseline")).toBeInTheDocument();

    // Automated tests: how to run them, and a status summary instead of tables.
    const automated = screen.getByRole("heading", { name: "Automated Tests" }).closest("section")!;
    expect(within(automated).getByText("pnpm test:e2e")).toBeInTheDocument();
    const status = within(automated).getByLabelText("Automated test status");
    expect(status).toHaveTextContent("1 of 1 test condition still recruiting — see the warning at the top.");
    expect(status).toHaveTextContent("2 test sessions — 1 never finished because a test run was interrupted");
    expect(screen.queryByLabelText("E2E test sessions")).toBeNull();
    expect(screen.queryByLabelText("E2E test conditions")).toBeNull();

    await openHistory(user);
    // Unfinished sessions are listed first.
    const table = screen.getByLabelText("E2E test sessions");
    const sessionRows = within(table).getAllByRole("row");
    expect(sessionRows).toHaveLength(3);
    expect(within(sessionRows[1]).getByText("active")).toBeInTheDocument();
    expect(within(table).queryByText("Baseline")).toBeNull();

    const conditions = screen.getByLabelText("E2E test conditions");
    const [header, row] = within(conditions).getAllByRole("row");
    expect(within(header).getByText("Created")).toBeInTheDocument();
    expect(within(row).getByText("E2E run")).toBeInTheDocument();
    const created = new Date("2026-09-20T10:03:00.000Z").toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    expect(within(row).getByRole("cell", { name: created })).toBeInTheDocument();
    expect(within(row).getByText("recruiting")).toBeInTheDocument();
    expect(within(row).getByRole("cell", { name: "2" })).toBeInTheDocument();
    expect(within(conditions).queryByText("Baseline")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Hide test history" }));
    expect(screen.queryByLabelText("E2E test conditions")).toBeNull();
  });

  it("reports all-clear when every test condition is off", () => {
    mockApi({});
    render(
      <Testing
        onSaved={vi.fn()}
        rows={[testRow("e2e-a", "2026-09-20T10:00:00.000Z"), testRow("e2e-b", "2026-09-21T10:00:00.000Z")]}
        sessions={[sessionSummary({ id: "t", conditionId: "e2e-a" })]}
      />,
    );
    expect(screen.queryByLabelText("Active test conditions")).toBeNull();
    const status = screen.getByLabelText("Automated test status");
    expect(within(status).getByText("All 2 test conditions are switched off.")).toHaveClass("ok");
    expect(status).toHaveTextContent("1 test session");
    expect(status).not.toHaveTextContent("never finished");
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
          testRow("e2e-on", "2026-09-20T10:00:00.000Z", true),
          testRow("e2e-off", "2026-09-21T10:00:00.000Z"),
        ]}
        sessions={[]}
      />,
    );
    await openHistory(user);
    const conditions = screen.getByLabelText("E2E test conditions");
    expect(within(conditions).queryByRole("checkbox")).toBeNull();
    expect(within(conditions).queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch off E2E e2e-off" })).toBeNull();
    expect(within(conditions).getByText("off")).toBeInTheDocument();

    await user.click(within(conditions).getByRole("button", { name: "Switch off E2E e2e-on" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(puts.map((p) => p.condition)).toEqual([
      expect.objectContaining({ id: "e2e-on", active: false }),
    ]);
  });

  it("switches off every recruiting test condition at once", async () => {
    const user = userEvent.setup();
    const puts: string[] = [];
    const handler = (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { condition: { id: string; active: boolean } };
      expect(body.condition.active).toBe(false);
      puts.push(body.condition.id);
      return { ok: true };
    };
    mockApi({ "/conditions/e2e-x": handler, "/conditions/e2e-y": handler });
    const onSaved = vi.fn();
    render(
      <Testing
        onSaved={onSaved}
        rows={[testRow("e2e-x", "2026-09-20T10:00:00.000Z", true), testRow("e2e-y", "2026-09-21T10:00:00.000Z", true)]}
        sessions={[]}
      />,
    );
    const warning = screen.getByLabelText("Active test conditions");
    expect(within(warning).getByText(/2 automated test conditions are still recruiting/)).toBeInTheDocument();
    await user.click(within(warning).getByRole("button", { name: "Switch off all 2" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(puts.sort()).toEqual(["e2e-x", "e2e-y"]);
  });

  it("reports a failed switch-off", async () => {
    const user = userEvent.setup();
    mockApi({ "/conditions/e2e-on": { status: 500 } });
    const onSaved = vi.fn();
    render(
      <Testing
        onSaved={onSaved}
        rows={[testRow("e2e-on", "2026-09-20T10:00:00.000Z", true)]}
        sessions={[]}
      />,
    );
    const warning = screen.getByLabelText("Active test conditions");
    await user.click(within(warning).getByRole("button", { name: "Switch off E2E e2e-on" }));
    expect(await within(warning).findByText("Error")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("refreshes after a partly failed bulk switch-off", async () => {
    const user = userEvent.setup();
    mockApi({ "/conditions/e2e-x": { ok: true }, "/conditions/e2e-y": { status: 500 } });
    const onSaved = vi.fn();
    render(
      <Testing
        onSaved={onSaved}
        rows={[testRow("e2e-x", "2026-09-21T10:00:00.000Z", true), testRow("e2e-y", "2026-09-20T10:00:00.000Z", true)]}
        sessions={[]}
      />,
    );
    const warning = screen.getByLabelText("Active test conditions");
    await user.click(within(warning).getByRole("button", { name: "Switch off all 2" }));
    expect(await within(warning).findByText("Error")).toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("lists active conditions first, then newest first, collapsed to ten", async () => {
    const user = userEvent.setup();
    mockApi({});
    const rows: ConditionProgress[] = Array.from({ length: 12 }, (_, i) =>
      testRow(`e2e-${String(i).padStart(2, "0")}`, `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`),
    );
    rows[0] = { ...rows[0], condition: { ...rows[0].condition, active: true } };
    rows.push({ ...progress({ id: "e2e-undated", name: "E2E undated", active: false }) });
    render(<Testing onSaved={vi.fn()} rows={rows} sessions={[]} />);
    await openHistory(user);

    const conditions = screen.getByLabelText("E2E test conditions");
    const names = () =>
      within(conditions)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByText(/^E2E /).textContent);
    expect(names()).toEqual([
      "E2E e2e-00",
      "E2E e2e-11",
      "E2E e2e-10",
      "E2E e2e-09",
      "E2E e2e-08",
      "E2E e2e-07",
      "E2E e2e-06",
      "E2E e2e-05",
      "E2E e2e-04",
      "E2E e2e-03",
    ]);

    await user.click(screen.getByRole("button", { name: "Show all 13 test conditions" }));
    expect(names()).toHaveLength(13);
    expect(names().at(-1)).toBe("E2E undated");
    const undated = within(conditions).getAllByRole("row").at(-1)!;
    expect(within(undated).getByRole("cell", { name: "unknown" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show only the newest 10" }));
    expect(names()).toHaveLength(10);
  });

  it("shows the empty state without residue", () => {
    mockApi({});
    render(<Testing onSaved={vi.fn()} rows={[progress({})]} sessions={[]} />);
    expect(screen.getByText("No automated test has run on this stack yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test history/ })).toBeNull();
    expect(screen.queryByLabelText("Active test conditions")).toBeNull();
    expect(screen.queryByText(/never finished/)).toBeNull();
  });
});
