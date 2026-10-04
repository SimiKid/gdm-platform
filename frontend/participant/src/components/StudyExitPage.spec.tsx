import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StudyExitPage from "./StudyExitPage";

describe("StudyExitPage", () => {
  it("shows the partial amount, the debrief and the Prolific return link", () => {
    render(
      <StudyExitPage
        prolificParticipant
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
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Prolific" })).toHaveAttribute(
      "href",
      "https://app.prolific.com/submissions/complete?cc=UNMATCHED",
    );
  });

  it("fails safely when a Prolific exit URL has not been configured", () => {
    render(
      <StudyExitPage
        prolificParticipant
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

  it("shows direct participants only the message and debrief, without a Prolific path", () => {
    render(
      <StudyExitPage
        prolificParticipant={false}
        termination={{
          outcome: "voluntary_withdrawal",
          compensationKind: "none",
          redirectUrl: "",
          message: "Your withdrawal was recorded. You may close this page.",
        }}
      />,
    );

    expect(screen.getByText(/Your withdrawal was recorded/)).toBeInTheDocument();
    expect(screen.getByText(/What this study was investigating/)).toBeInTheDocument();
    expect(screen.queryByText("Return to Prolific")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
