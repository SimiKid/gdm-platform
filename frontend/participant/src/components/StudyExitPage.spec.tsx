import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StudyExitPage from "./StudyExitPage";

describe("StudyExitPage", () => {
  it("shows the partial amount and gates the Prolific path on the debrief", async () => {
    const user = userEvent.setup();
    render(
      <StudyExitPage
        termination={{
          outcome: "unmatched",
          compensationKind: "partial",
          compensationAmountPence: 125,
          redirectUrl:
            "https://app.prolific.com/submissions/complete?cc=UNMATCHED",
          message: "A complete group could not be formed.",
        }}
      />,
    );

    expect(screen.getByText("£1.25")).toBeInTheDocument();
    expect(screen.getByText(/What this study was investigating/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Return to Prolific" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", { name: /read and understood the debriefing/i }),
    );
    expect(screen.getByRole("link", { name: "Return to Prolific" })).toHaveAttribute(
      "href",
      "https://app.prolific.com/submissions/complete?cc=UNMATCHED",
    );
  });

  it("fails safely when an exit URL has not been configured", () => {
    render(
      <StudyExitPage
        termination={{
          outcome: "declined_consent",
          compensationKind: "none",
          redirectUrl: "",
          message: "Consent was declined.",
        }}
      />,
    );

    expect(screen.queryByText(/What this study was investigating/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to Prolific" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/not configured/i);
  });
});
