import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SessionDetail from "./SessionDetail";
import { session } from "../test-utils";

describe("SessionDetail", () => {
  const cellsOf = (row: HTMLElement) =>
    [...(row as HTMLTableRowElement).cells].map((c) => c.textContent);

  it("lists participants by their chat colour names in a per-person activity table", () => {
    render(<SessionDetail session={session()} />);
    const table = screen.getByLabelText("Participants");
    expect(within(table).getByText("Red")).toBeInTheDocument();
    expect(within(table).getByText("Blue")).toBeInTheDocument();
    expect(within(table).getByText("Green")).toBeInTheDocument();
    expect(table).not.toHaveTextContent("tok-");
    expect(cellsOf(within(table).getByText("Red").closest("tr")!)).toEqual(["Red", "3", "0:05", "0", "2"]);
    // Totals row, with the bot's own messages kept apart.
    expect(cellsOf(within(table).getByText("All").closest("tr")!)).toEqual(["All", "6 + 1 bot", "0:08", "1", "2"]);
  });

  it("adds only what the session row lacks to the head, plus the tiles", () => {
    render(<SessionDetail session={session()} />);
    expect(screen.getByText("bot public")).toBeInTheDocument();
    expect(screen.getByText("10:00 of 10 min")).toBeInTheDocument();
    expect(screen.getByText("!room:localhost")).toBeInTheDocument();
    // Status and round live in the session row the inspector unfolds under.
    expect(screen.queryByText("Round 1")).toBeNull();
    expect(screen.queryByText("completed")).toBeNull();
    expect(screen.getByText("Nudges").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Classifier").nextElementSibling).toHaveTextContent(
      "2 of 6 messages classified",
    );
    expect(screen.getByText("mean meaningfulness 0.50 · 1 failed")).toBeInTheDocument();
    expect(screen.getByText("Ranking edits").nextElementSibling).toHaveTextContent("2");
  });

  it("names each line in the right gutter, apart and inside the plot height", () => {
    // Last window: Blue and Green both end at 50%, Red at 0% on the bottom edge.
    render(<SessionDetail session={session()} />);
    const labels = screen.getAllByTestId("end-label").map((g) => {
      const text = g.querySelector("text")!;
      return { name: text.textContent, x: Number(text.getAttribute("x")), y: Number(text.getAttribute("y")) };
    });
    expect(labels.map((l) => l.name).sort()).toEqual(["Blue", "Green", "Red"]);
    // Right of the plot (W 720 − RIGHT 64 = 656), clear of the wrap-up band.
    expect(labels.every((l) => l.x > 656)).toBe(true);
    const ys = labels.map((l) => l.y).sort((a, b) => a - b);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(12);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(12);
    // Never below the plot's bottom edge (TOP 24 + PLOT_H 140), i.e. off the time axis.
    expect(Math.max(...ys)).toBeLessThanOrEqual(164 + 4);
  });

  it("draws one step line per participant, a marker per nudge and target, and the message ticks", () => {
    const { container } = render(<SessionDetail session={session()} />);
    const series = screen.getAllByTestId("share-series");
    expect(series).toHaveLength(3);
    // Three contiguous windows → one run: a flat step per window joined by risers.
    expect(series[0].getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+ V[\d.]+ H[\d.]+$/);
    expect(screen.getAllByTestId("nudge-marker")).toHaveLength(1);
    expect(screen.getAllByTestId("target-marker")).toHaveLength(1);
    expect(screen.queryAllByTestId("suppressed-marker")).toHaveLength(0);
    // 6 participant messages → 6 ticks; the bot message draws none.
    expect(container.querySelectorAll("rect[height='7']")).toHaveLength(6);
    expect(screen.getByRole("img")).toHaveAccessibleName(/1 nudge markers/);
  });

  it("keys only the marks the chart shows", () => {
    render(<SessionDetail session={session()} />);
    const key = screen.getByLabelText("Chart key");
    expect(key).toHaveTextContent("share of one bot window");
    expect(key).toHaveTextContent("public nudge");
    expect(key).toHaveTextContent("person the nudge targeted");
    expect(key).toHaveTextContent("one tick per message");
    expect(key).not.toHaveTextContent("private nudge");
    expect(key).not.toHaveTextContent("would have nudged");
  });

  it("explains each nudge with a before/after table in the bot's windows", () => {
    render(<SessionDetail session={session()} />);
    expect(screen.getByText("target Red")).toBeInTheDocument();
    expect(screen.getByText("window 1 → window 2")).toBeInTheDocument();
    expect(screen.queryByText(/plain message shares/)).toBeNull();
    expect(screen.getByText(/Red, you have written 67%/)).toBeInTheDocument();
    const rows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByText(/^(target|quiet member|other)$/));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Red");
    expect(rows[0]).toHaveTextContent("67% → 34%");
    expect(cellsOf(rows[0])[3]).toBe("2 → 1");
    expect(rows[0]).not.toHaveTextContent("pp");
    expect(rows[1]).toHaveTextContent("Blue");
    expect(rows[1]).toHaveTextContent("other");
    expect(rows[2]).toHaveTextContent("Green");
    expect(rows[2]).toHaveTextContent("0% → 33%");
    expect(screen.getByText("Active participants 2 → 3")).toBeInTheDocument();
  });

  it("reads the active window on hover and via the keyboard", () => {
    render(<SessionDetail session={session()} />);
    const svg = screen.getByRole("img");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.keyDown(svg, { key: "ArrowRight" });
    const tip = screen.getByRole("status");
    expect(tip).toHaveTextContent("Window 1 · 1:00–3:00 · nudged");
    expect(tip).toHaveTextContent("67%Red · 2 msgs");
    expect(tip).toHaveTextContent("nudged Red");
    expect(screen.getByTestId("crosshair")).toBeInTheDocument();

    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.getByRole("status")).toHaveTextContent("Window 2");
    fireEvent.keyDown(svg, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();

    // jsdom reports a zero-width box, so client x maps 1:1 onto viewBox units.
    // A MouseEvent keeps clientX where jsdom's PointerEvent shim would drop it.
    act(() => {
      svg.dispatchEvent(new MouseEvent("pointermove", { clientX: 700, bubbles: true }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Window 3");
    // Inside a window's span picks that window (window 2 spans x 227.6–350).
    act(() => {
      svg.dispatchEvent(new MouseEvent("pointermove", { clientX: 240, bubbles: true }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Window 2");
    fireEvent.pointerLeave(svg);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("marks counterfactual windows in a baseline session and reports the classifier as unused", () => {
    const s = session({ interventions: [], contributionClassifications: [], classificationFailures: [] });
    s.condition = {
      ...s.condition,
      name: "Baseline",
      config: { ...s.condition.config, interventionMode: "baseline", llmMode: "off" },
    };
    s.windowEvaluations = s.windowEvaluations!.map((w) => ({
      ...w,
      llmMode: "off",
      outcome: w.windowIndex === 0 ? "baseline-suppressed" : w.outcome,
      interventionId: null,
    }));
    render(<SessionDetail session={s} />);
    expect(screen.getByText("Classifier").nextElementSibling).toHaveTextContent("not used");
    expect(screen.getByText("baseline arm never delivers")).toBeInTheDocument();
    expect(screen.getByText("No nudges delivered (baseline arm).")).toBeInTheDocument();
    expect(screen.getAllByTestId("suppressed-marker")).toHaveLength(1);
    expect(screen.getByText(/Would have targeted Red at 3:00/)).toBeInTheDocument();
    expect(screen.queryAllByTestId("nudge-marker")).toHaveLength(0);
    expect(screen.queryAllByTestId("target-marker")).toHaveLength(0);
    const key = screen.getByLabelText("Chart key");
    expect(key).toHaveTextContent("would have nudged (baseline, not sent)");
    expect(key).not.toHaveTextContent("nudge targeted");
  });

  it("shows an empty state before the chat starts", () => {
    const s = session({
      status: "waiting",
      startedAt: undefined,
      completedAt: undefined,
      roomId: undefined,
      windowEvaluations: [],
      interventions: [],
      chat: { messages: [] },
      behavioralEvents: [],
      contributionClassifications: [],
    });
    s.participants = s.participants.map((p) => ({ ...p, matrixUserId: undefined }));
    render(<SessionDetail session={s} />);
    expect(screen.queryByText(/ of 10 min/)).toBeNull();
    expect(screen.getByText("room not provisioned")).toBeInTheDocument();
    expect(screen.getByText("Timeline appears once the chat starts.")).toBeInTheDocument();
    expect(screen.getByText("No nudge fired in this session.")).toBeInTheDocument();
    // Unprovisioned participants fall back to their token prefix.
    expect(screen.getByText("tok-aaaa")).toBeInTheDocument();
    expect(screen.getAllByText("no activity yet")).toHaveLength(3);
  });

  it("keeps drawing while a session is live without evaluated windows", () => {
    const s = session({
      status: "running",
      completedAt: undefined,
      windowEvaluations: [],
      interventions: [],
    });
    render(<SessionDetail session={s} />);
    expect(screen.queryAllByTestId("share-series")).toHaveLength(0);
    expect(screen.getByText(/first one closes at 3:00/)).toBeInTheDocument();
    expect(screen.getByText("No nudge fired in this session.")).toBeInTheDocument();
    const svg = screen.getByRole("img");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("compares message shares over the rest of the chat when no later window exists", () => {
    render(<SessionDetail session={session({ windowEvaluations: [] })} />);
    expect(screen.getByText("window not linked → messages 3:00–10:00")).toBeInTheDocument();
    expect(screen.getByText("No contribution window was evaluated in this session.")).toBeInTheDocument();
    expect(screen.getByText(/the chat ended first\), so both sides are plain message shares/)).toBeInTheDocument();
    expect(screen.getByText("Message share before → after")).toBeInTheDocument();
    const rows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByText(/^(target|quiet member|other)$/));
    expect(rows[0]).toHaveTextContent("67% → 33%");
    expect(cellsOf(rows[0])[3]).toBe("2 → 1");
    expect(screen.getByText("Active participants 2 → 3")).toBeInTheDocument();
  });
});
