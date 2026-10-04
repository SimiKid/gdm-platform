import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import ConsentPage from "./ConsentPage";

describe("ConsentPage", () => {
  it("quotes the live group size on the introduction", () => {
    render(<ConsentPage groupSize={4} onBegin={vi.fn()} />);

    expect(
      screen.getByText(
        /timed group decision with 4 fully anonymized participants in total, who are randomly assigned to groups\./,
      ),
    ).toBeInTheDocument();
  });

  it("omits the number while the group size is unknown", () => {
    render(<ConsentPage onBegin={vi.fn()} />);

    expect(
      screen.getByText(
        /timed group decision with fully anonymized participants, who are randomly assigned to groups\./,
      ),
    ).toBeInTheDocument();
  });
});
