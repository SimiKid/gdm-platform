import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import DebriefingPage from "./DebriefingPage";

describe("DebriefingPage", () => {
  it("finishes direct participation locally without exposing a Prolific link", async () => {
    render(
      <DebriefingPage
        prolificParticipant={false}
        sessionId="session-direct"
        participantId="participant-direct"
      />,
    );

    const finish = screen.getByRole("button", { name: "Finish study" });
    expect(finish).toBeDisabled();
    expect(screen.queryByText("Return to Prolific")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I have read and understood the debriefing above.",
      }),
    );
    await userEvent.click(finish);

    expect(
      screen.getByText("Your participation is complete. You may close this tab."),
    ).toBeInTheDocument();
  });

  it("keeps the completion redirect exclusive to Prolific participants", async () => {
    render(
      <DebriefingPage
        prolificParticipant
        completionUrl="https://app.prolific.com/submissions/complete?cc=TEST"
        sessionId="session-prolific"
        participantId="participant-prolific"
      />,
    );

    expect(screen.getByRole("button", { name: "Return to Prolific" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("checkbox", {
        name: "I have read and understood the debriefing above.",
      }),
    );
    expect(screen.getByRole("link", { name: "Return to Prolific" })).toHaveAttribute(
      "href",
      "https://app.prolific.com/submissions/complete?cc=TEST",
    );
  });
});
