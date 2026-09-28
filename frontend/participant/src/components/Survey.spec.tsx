import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Survey from "./Survey";

async function completeConsent() {
  // Step 1: intro screen — tick acknowledgment, then continue to consent form
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(
    screen.getByRole("button", { name: /continue to the consent form/i }),
  );
  // Step 2: consent form — tick all boxes and begin
  for (const box of screen.getAllByRole("checkbox")) {
    await userEvent.click(box);
  }
  await userEvent.click(screen.getByRole("button", { name: "Begin study" }));
}

async function completeAboutYou() {
  await userEvent.type(screen.getByLabelText("How old are you?"), "30");
  await userEvent.click(screen.getByRole("radio", { name: "Woman" }));
  await userEvent.click(
    screen.getByRole("radio", { name: "Bachelor's degree" }),
  );
  await userEvent.click(
    screen.getByRole("radio", { name: "Fluent (advanced)" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function completeMatrix() {
  // "Disagree strongly" is the first option in both matrices.
  for (const radio of screen.getAllByRole("radio", {
    name: /: Disagree strongly$/i,
  })) {
    await userEvent.click(radio);
  }
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function completeAttitudes() {
  // Screen 1/2 — AI attitudes, then screen 2/2 — personality.
  await completeMatrix();
  expect(
    screen.getByText(/Attitudes & Traits \(2\/2\)/),
  ).toBeInTheDocument();
  await completeMatrix();

  // Screen 3 — Skills & Experience single items.
  expect(screen.getByText("Skills & Experience")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Sometimes" }));
  const comfort = screen.getByRole("group", {
    name: /communicating via text chat/,
  });
  await userEvent.click(
    within(comfort).getByRole("radio", { name: "Rather comfortable" }),
  );
  const spaceflight = screen.getByRole("group", {
    name: /spaceflight-related/,
  });
  await userEvent.click(
    within(spaceflight).getByRole("radio", { name: "Rather unfamiliar" }),
  );
  const survival = screen.getByRole("group", {
    name: /wilderness.*survival/i,
  });
  await userEvent.click(
    within(survival).getByRole("radio", { name: "Rather unfamiliar" }),
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

describe("Survey", () => {
  it("walks consent → background info → attitudes → task → group phase and returns the entry survey", async () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);

    // Page 1 — intro then consent
    expect(screen.getByText(/Welcome to the Study/)).toBeInTheDocument();
    await completeConsent();

    // Page 2 — background info (demographics)
    expect(screen.getByText(/Background Info/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await completeAboutYou();

    // Page 3 — attitudes & traits (2 screens) then skills & experience
    expect(
      screen.getByText(/attitudes towards Artificial Intelligence/),
    ).toBeInTheDocument();
    await completeAttitudes();

    // Page 4 — individual ranking task with the 5-minute timer.
    expect(screen.getByText(/Task: Survival on the Moon/)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Submit my ranking" });
    expect(submit).toBeDisabled();
    await rankAllItems();
    expect(submit).toBeEnabled();
    // exercise the reorder controls: move item 1 down
    await userEvent.click(screen.getAllByRole("button", { name: /Move .* down/ })[0]);
    await userEvent.click(submit);

    // Page 5 — group phase instructions gate "Join chat" on the checkbox.
    const join = screen.getByRole("button", { name: "Join chat" });
    expect(join).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(join);

    expect(onComplete).toHaveBeenCalledOnce();
    const survey = onComplete.mock.calls[0][0];
    expect(survey.answers.consentParticipation).toBe(true);
    expect(survey.answers.age).toBe(30);
    expect(survey.answers.gender).toBe("woman");
    expect(survey.answers.education).toBe("bachelors");
    expect(survey.answers.englishProficiency).toBe("fluent");
    expect(survey.answers.gaais1).toBe(1);
    expect(survey.answers.tipi1).toBe(1);
    expect(survey.answers.teamworkFrequency).toBe("sometimes");
    expect(survey.answers.chatComfort).toBe(4);
    expect(survey.answers.spaceflightFamiliarity).toBe(2);
    expect(survey.answers.survivalFamiliarity).toBe(2);
    expect(survey.answers.rankingCompleted).toBe(true);
  });

  it("keeps Begin study disabled until every consent box is ticked", async () => {
    render(<Survey onComplete={vi.fn()} />);
    // Advance past the intro screen to reach the consent form.
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: /continue to the consent form/i }),
    );
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const box of boxes.slice(0, -1)) await userEvent.click(box);
    expect(screen.getByRole("button", { name: "Begin study" })).toBeDisabled();
    await userEvent.click(boxes[boxes.length - 1]);
    expect(screen.getByRole("button", { name: "Begin study" })).toBeEnabled();
  });
});
