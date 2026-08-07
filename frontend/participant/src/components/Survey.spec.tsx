import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Survey from "./Survey";

async function completeConsent() {
  for (const box of screen.getAllByRole("checkbox")) {
    await userEvent.click(box);
  }
  await userEvent.click(screen.getByRole("button", { name: "Begin study" }));
}

async function completeAboutYou() {
  await userEvent.type(screen.getByLabelText("Age"), "30");
  await userEvent.click(screen.getByRole("radio", { name: "Female" }));
  await userEvent.selectOptions(
    screen.getByLabelText("Highest level of education"),
    "Master's degree",
  );
  await userEvent.type(
    screen.getByLabelText("Field of study or occupation"),
    "Computer science",
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function rankAllItems() {
  // Keyboard-accessible alternative to drag-and-drop: the "Add" buttons.
  let addButtons = screen.getAllByRole("button", { name: /^Add .* to the ranking$/ });
  while (addButtons.length > 0) {
    await userEvent.click(addButtons[0]);
    addButtons = screen.queryAllByRole("button", {
      name: /^Add .* to the ranking$/,
    });
  }
}

async function answerFollowUps() {
  await userEvent.click(screen.getByRole("radio", { name: "Fluent" }));
  await userEvent.click(screen.getByRole("radio", { name: "Sometimes" }));
  const comfort = screen.getByRole("group", {
    name: /communicating via text chat/,
  });
  await userEvent.click(within(comfort).getByRole("radio", { name: "6" }));
  const familiarity = screen.getByRole("group", {
    name: /spaceflight or survival/,
  });
  await userEvent.click(within(familiarity).getByRole("radio", { name: "2" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("Survey", () => {
  it("walks consent → about you → task → group phase and returns the entry survey", async () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);

    // Page 1 — consent: Begin study only enables once all boxes are ticked.
    expect(
      screen.getByText(/Welcome to the Group Decision-Making Study/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Begin study" })).toBeDisabled();
    await completeConsent();

    // Page 2 — about you
    expect(screen.getByText(/A few questions about you/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await completeAboutYou();

    // Page 3 — individual ranking task with the 10-minute timer.
    expect(screen.getByText(/Survival on the Moon/)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Submit my ranking" });
    expect(submit).toBeDisabled();
    await rankAllItems();
    expect(submit).toBeEnabled();
    // exercise the reorder controls: move item 1 down
    await userEvent.click(screen.getAllByRole("button", { name: /Move .* down/ })[0]);
    await userEvent.click(submit);

    // Page 3 (continued) — follow-up questions without time pressure.
    expect(screen.getByText(/A few more questions/)).toBeInTheDocument();
    await answerFollowUps();

    // Page 4 — group phase instructions gate "Join chat" on the checkbox.
    const join = screen.getByRole("button", { name: "Join chat" });
    expect(join).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(join);

    expect(onComplete).toHaveBeenCalledOnce();
    const survey = onComplete.mock.calls[0][0];
    expect(survey.answers.consentParticipation).toBe(true);
    expect(survey.answers.age).toBe(30);
    expect(survey.answers.gender).toBe("female");
    expect(survey.answers.education).toBe("Master's degree");
    expect(survey.answers.individualRanking).toHaveLength(10);
    expect(survey.answers.rankingCompleted).toBe(true);
    expect(survey.answers.englishProficiency).toBe("fluent");
    expect(survey.answers.chatComfort).toBe(6);
    expect(survey.answers.topicFamiliarity).toBe(2);
  });

  it("keeps Begin study disabled until every consent box is ticked", async () => {
    render(<Survey onComplete={vi.fn()} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[1]);
    expect(screen.getByRole("button", { name: "Begin study" })).toBeDisabled();
    await userEvent.click(boxes[2]);
    expect(screen.getByRole("button", { name: "Begin study" })).toBeEnabled();
  });
});
