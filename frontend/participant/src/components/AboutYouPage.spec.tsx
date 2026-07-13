import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AboutYouPage from "./AboutYouPage";

describe("AboutYouPage", () => {
  it("explains why an under-18 participant cannot continue", async () => {
    const user = userEvent.setup();
    render(<AboutYouPage onContinue={vi.fn()} />);

    await user.type(screen.getByLabelText("Age"), "17");

    expect(
      screen.getByText("You must be at least 18 years old to participate."),
    ).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});
