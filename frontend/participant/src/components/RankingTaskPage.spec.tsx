import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RankingTaskPage from "./RankingTaskPage";

describe("RankingTaskPage", () => {
  it("names the live group size and shows the shared briefing", () => {
    render(<RankingTaskPage onComplete={vi.fn()} groupSize={3} />);

    expect(
      screen.getByText(/discuss the task in your group of 3\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/As part of a space crew/)).toBeInTheDocument();
  });

  it("keeps the wording number-free while the group size is unknown", () => {
    render(<RankingTaskPage onComplete={vi.fn()} />);

    expect(screen.getByText(/discuss the task in your group\./)).toBeInTheDocument();
  });
});
