import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SessionDetail from "./SessionDetail";
import { session } from "../test-utils";

describe("SessionDetail", () => {
  it("shows participants by their chat colour names with per-person activity", () => {
    render(<SessionDetail session={session()} />);
    const legend = screen.getByLabelText("Participants");
    expect(within(legend).getByText("Red")).toBeInTheDocument();
    expect(within(legend).getByText("Blue")).toBeInTheDocument();
    expect(within(legend).getByText("Green")).toBeInTheDocument();
    expect(legend).not.toHaveTextContent("tok-");
    expect(within(legend).getByText("Red").nextElementSibling).toHaveTextContent(
      "3 msgs · typing 0:05 · 0 tab switches · 2 ranking moves",
    );
  });

  it("summarises the session in the header and the tiles", () => {
    render(<SessionDetail session={session()} />);
    expect(screen.getByText("completed")).toHaveClass("status", "completed");
    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getByText("10:00 of 10 min")).toBeInTheDocument();
    expect(screen.getByText("Messages").nextElementSibling).toHaveTextContent("6");
    expect(screen.getByText("+ 1 bot message")).toBeInTheDocument();
    expect(screen.getByText("Nudges").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Classifier").nextElementSibling).toHaveTextContent(
      "2 of 6 messages classified",
    );
    expect(screen.getByText("mean meaningfulness 0.50 · 1 failed")).toBeInTheDocument();
    expect(screen.getByText("Ranking edits").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Behaviour").nextElementSibling).toHaveTextContent("typing 0:08");
    expect(screen.getByText("1 tab switch · 2 ranking moves")).toBeInTheDocument();
  });

  it("draws one line per participant, a marker per nudge and the message ticks", () => {
    const { container } = render(<SessionDetail session={session()} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(3);
    expect(screen.getAllByTestId("nudge-marker")).toHaveLength(1);
    expect(screen.queryAllByTestId("suppressed-marker")).toHaveLength(0);
    // 6 participant messages → 6 ticks; the bot message draws none.
    expect(container.querySelectorAll("rect[height='7']")).toHaveLength(6);
    expect(screen.getByRole("img")).toHaveAccessibleName(/1 nudge markers/);
  });

  it("explains each nudge with a before/after table in the bot's windows", () => {
    render(<SessionDetail session={session()} />);
    expect(screen.getByText("target Red")).toBeInTheDocument();
    expect(screen.getByText("window 1 → 2")).toBeInTheDocument();
    expect(screen.getByText(/Red, you have written 67%/)).toBeInTheDocument();
    const rows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByText(/^(target|quiet member)$/));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Red");
    expect(rows[0]).toHaveTextContent("67% → 34% (−33 pp)");
    expect(rows[0]).toHaveTextContent("2 → 1 (−1)");
    expect(within(rows[0]).getAllByText(/pp\)|\(−1\)/)[0]).toHaveClass("delta", "good");
    expect(rows[1]).toHaveTextContent("Green");
    expect(rows[1]).toHaveTextContent("0% → 33% (+33 pp)");
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
    expect(screen.getByText("lobby")).toHaveClass("status", "waiting");
    expect(screen.getByText("not started")).toBeInTheDocument();
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
    const { container } = render(<SessionDetail session={s} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(screen.getByText(/first one closes at 3:00/)).toBeInTheDocument();
    expect(screen.getByText("No nudge fired in this session.")).toBeInTheDocument();
    const svg = screen.getByRole("img");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falls back gracefully when a nudge cannot be linked to a window", () => {
    render(<SessionDetail session={session({ windowEvaluations: [] })} />);
    expect(screen.getByText("window not linked")).toBeInTheDocument();
    expect(screen.getByText("No contribution window was evaluated in this session.")).toBeInTheDocument();
    const rows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByText(/^(target|quiet member)$/));
    expect(rows[0]).toHaveTextContent("67% → —");
    expect(screen.getByText("Active participants 2 → no later window yet")).toBeInTheDocument();
  });
});
