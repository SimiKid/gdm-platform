import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import GroupIntroPage from "./GroupIntroPage";

describe("GroupIntroPage", () => {
  it("quotes the live group size and discussion length", () => {
    render(<GroupIntroPage onJoin={vi.fn()} groupSize={3} durationMinutes={15} />);

    expect(
      screen.getByText(/Your group of 3 participants will be randomly assembled/),
    ).toBeInTheDocument();
    expect(screen.getByText(/with your 2 team members, your goal/)).toBeInTheDocument();
    expect(screen.getByText("You have 15 minutes to complete the task.")).toBeInTheDocument();
  });

  it("uses a singular team member for a pair", () => {
    render(<GroupIntroPage onJoin={vi.fn()} groupSize={2} durationMinutes={10} />);

    expect(screen.getByText(/with your 1 team member, your goal/)).toBeInTheDocument();
  });

  it("falls back to number-free wording while the study info is unknown", () => {
    render(<GroupIntroPage onJoin={vi.fn()} />);

    expect(
      screen.getByText(/Your group will be randomly assembled\. Together with your team members, your goal/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("You have the time shown by the timer to complete the task."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\d+ (participants|minutes)/)).not.toBeInTheDocument();
  });
});
