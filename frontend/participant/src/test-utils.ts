import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Rank every item via the keyboard-accessible "Add" buttons of RankingBoard. */
export async function rankAllItems() {
  let addButtons = screen.getAllByRole("button", {
    name: /^Add .* to the ranking$/,
  });
  while (addButtons.length > 0) {
    await userEvent.click(addButtons[0]);
    addButtons = screen.queryAllByRole("button", {
      name: /^Add .* to the ranking$/,
    });
  }
}
