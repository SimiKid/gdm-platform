import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AboutYouPage from "./AboutYouPage";

describe("AboutYouPage", () => {
  it("explains why an under-18 participant cannot continue", async () => {
    const user = userEvent.setup();
    const onIneligible = vi.fn();
    render(
      <AboutYouPage onContinue={vi.fn()} onIneligible={onIneligible} />,
    );

    await user.type(screen.getByLabelText("How old are you?"), "17");
    await user.tab();

    expect(
      screen.getByText("You must be at least 18 years old to participate."),
    ).toHaveAttribute("role", "alert");
    expect(onIneligible).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

describe("AboutYouPage – free-text options and submission", () => {
  it("collects self-described gender, other education and the age opt-out", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    render(<AboutYouPage onContinue={onContinue} onIneligible={vi.fn()} />);
    const continueButton = screen.getByRole("button", { name: "Continue" });

    await user.click(screen.getByRole("checkbox", { name: "Prefer not to say" }));
    expect(screen.getByLabelText("How old are you?")).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Prefer to self-describe" }));
    await user.click(screen.getByRole("radio", { name: "Other" }));
    await user.click(screen.getByRole("radio", { name: "Native / Bilingual" }));
    // Both free-text fields are still empty, so the page is not ready yet.
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByLabelText("Please describe"), " agender ");
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByLabelText("Please specify"), " PhD candidate ");
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(onContinue).toHaveBeenCalledWith({
      gender: "self-describe",
      genderCustom: "agender",
      education: "other",
      educationOther: "PhD candidate",
      englishProficiency: "native_bilingual",
      agePreferNotToSay: true,
    });
  });

  it("submits a numeric age and flags participants without English", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const onIneligible = vi.fn();
    render(<AboutYouPage onContinue={onContinue} onIneligible={onIneligible} />);

    await user.type(screen.getByLabelText("How old are you?"), "34");
    await user.click(screen.getByRole("radio", { name: "Woman" }));
    await user.click(screen.getByRole("radio", { name: "Master's degree or higher" }));
    await user.click(screen.getByRole("radio", { name: "None" }));
    expect(onIneligible).toHaveBeenCalledWith(
      expect.stringContaining("no English proficiency"),
    );

    await user.click(screen.getByRole("radio", { name: "Intermediate" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onContinue).toHaveBeenCalledWith({
      gender: "woman",
      education: "masters_or_higher",
      englishProficiency: "intermediate",
      age: 34,
    });
  });
});
