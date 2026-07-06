import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Survey from "./Survey";

describe("Survey", () => {
  it("walks questions → briefing → consent and returns an entry survey", async () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);

    // Step 1 — questions
    expect(screen.getByText(/A few questions/)).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("Age"), "30");
    const [gender, experience] = screen.getAllByRole("combobox");
    await userEvent.selectOptions(gender, "female");
    await userEvent.selectOptions(experience, "some");
    await userEvent.click(screen.getByText("Continue"));

    // Step 2 — briefing + individual ranking
    expect(screen.getByText(/Expedition Mars/)).toBeInTheDocument();
    // reorder the top item down to exercise the ranking controls
    const downButtons = screen.getAllByLabelText("Move down");
    await userEvent.click(downButtons[0]);
    await userEvent.click(screen.getByText("Continue"));

    // Step 3 — consent
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByText("Finish"));

    expect(onComplete).toHaveBeenCalledOnce();
    const survey = onComplete.mock.calls[0][0];
    expect(survey.answers.age).toBe(30);
    expect(survey.answers.gender).toBe("female");
    expect(Array.isArray(survey.answers.individualRanking)).toBe(true);
    expect(survey.answers.individualRanking).toHaveLength(10);
  });

  it("blocks Finish until consent is given", async () => {
    render(<Survey onComplete={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText("Age"), "25");
    const [gender, experience] = screen.getAllByRole("combobox");
    await userEvent.selectOptions(gender, "male");
    await userEvent.selectOptions(experience, "none");
    await userEvent.click(screen.getByText("Continue"));
    await userEvent.click(screen.getByText("Continue"));
    expect(screen.getByText("Finish")).toBeDisabled();
  });
});
