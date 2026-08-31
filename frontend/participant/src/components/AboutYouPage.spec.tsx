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
