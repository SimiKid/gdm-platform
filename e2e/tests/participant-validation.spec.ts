import { expect, test } from "@playwright/test";
import { uniqueId } from "../support/e2e-helpers";

test("@validation participant forms explain and block incomplete answers", async ({
  page,
}) => {
  // No session is opened in this test. The forced id still guarantees that an
  // accidental future join cannot place this browser in a real study arm.
  await page.goto(`/?conditionId=${uniqueId("validation")}`);
  await page.getByRole("button", { name: "Start" }).click();

  await test.step("consent stays blocked until every declaration is checked", async () => {
    const begin = page.getByRole("button", { name: "Begin study" });
    const boxes = page.getByRole("checkbox");
    await expect(begin).toBeDisabled();
    await expect(page.getByText("Please tick all three boxes above to begin.")).toBeVisible();
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(begin).toBeDisabled();
    await boxes.nth(2).check();
    await expect(begin).toBeEnabled();
    await begin.click();
  });

  await test.step("under-18 and incomplete demographic answers give specific feedback", async () => {
    const continueButton = page.getByRole("button", { name: "Continue" });
    const age = page.locator("#about-age");
    await expect(continueButton).toBeDisabled();
    await age.fill("17");
    await expect(
      page.getByRole("alert").filter({
        hasText: "You must be at least 18 years old to participate.",
      }),
    ).toBeVisible();
    await expect(age).toHaveAttribute("aria-invalid", "true");
    await expect(continueButton).toBeDisabled();

    await age.fill("121");
    await expect(
      page.getByRole("alert").filter({
        hasText: "Please enter a valid age between 18 and 120.",
      }),
    ).toBeVisible();

    await age.fill("18");
    await page.getByRole("radio", { name: "Prefer not to say" }).check();
    await page.getByRole("radio", { name: "Bachelor's degree" }).check();
    await expect(continueButton).toBeDisabled();
    await page.getByRole("radio", { name: "Fluent (advanced)" }).check();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();
  });

  await test.step("the individual ranking requires all items", async () => {
    const submit = page.getByRole("button", { name: "Submit my ranking" });
    const addButtons = page.getByRole("button", {
      name: /^Add .* to the ranking$/,
    });
    await expect(submit).toBeDisabled();
    await expect(page.getByText("Rank all 10 items to submit (10 remaining).")).toBeVisible();
    await addButtons.first().click();
    await expect(page.getByText("Rank all 10 items to submit (9 remaining).")).toBeVisible();
    while ((await addButtons.count()) > 0) await addButtons.first().click();
    await expect(submit).toBeEnabled();
    await submit.click();
  });

  await test.step("follow-up questions and group acknowledgment are mandatory", async () => {
    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect(continueButton).toBeDisabled();
    await page.getByRole("radio", { name: "Fluent" }).check();
    await page
      .getByRole("group", { name: "How often do you work on tasks in teams?" })
      .getByRole("radio", { name: "Sometimes" })
      .check();
    await page
      .getByRole("group", {
        name: "How comfortable are you communicating via text chat?",
      })
      .getByRole("radio", { name: "5", exact: true })
      .check();
    await expect(continueButton).toBeDisabled();
    await page
      .getByRole("group", {
        name: "How familiar are you with spaceflight or survival-related topics?",
      })
      .getByRole("radio", { name: "4", exact: true })
      .check();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    const join = page.getByRole("button", { name: "Join chat" });
    await expect(join).toBeDisabled();
    await page.getByRole("checkbox").check();
    await expect(join).toBeEnabled();
  });
});
