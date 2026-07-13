import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MOON_SURVIVAL } from "@gdm/shared";
import type { Session } from "@gdm/shared";
import ExitSurvey from "./ExitSurvey";

const session = {
  id: "s",
  roomId: "!r",
  rankingTask: MOON_SURVIVAL,
  ranking: {
    taskId: MOON_SURVIVAL.id,
    order: MOON_SURVIVAL.items.map((i) => i.id),
    updatedAt: "",
    updatedBy: "",
  },
} as unknown as Session;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
});
afterEach(() => vi.unstubAllGlobals());

async function rankAllItems() {
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

describe("ExitSurvey", () => {
  it("requires the final ranking and all ratings, then completes the session", async () => {
    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" onDone={onDone} />);
    expect(
      screen.getByText(/Almost done: A few final questions/),
    ).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeDisabled();

    await rankAllItems();
    expect(submit).toBeDisabled(); // ratings still missing

    const satisfaction = screen.getByRole("group", {
      name: /satisfied are you with the group's final ranking/,
    });
    await userEvent.click(
      within(satisfaction).getByRole("radio", { name: "6" }),
    );
    const fairness = screen.getByRole("group", {
      name: /reached its decision fairly/,
    });
    await userEvent.click(within(fairness).getByRole("radio", { name: "5" }));
    const heard = screen.getByRole("group", { name: /views were heard/ });
    await userEvent.click(within(heard).getByRole("radio", { name: "7" }));

    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/surveys"),
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/complete"),
      expect.any(Object),
    );

    // The persisted exit survey carries the fresh 15-item ranking + ratings.
    const surveyCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => String(url).includes("/surveys"),
    );
    const body = JSON.parse(surveyCall![1].body);
    expect(body.survey.answers.finalRanking).toHaveLength(15);
    expect(body.survey.answers.satisfaction).toBe(6);
    expect(body.survey.answers.fairness).toBe(5);
    expect(body.survey.answers.feltHeard).toBe(7);
  });

  it("keeps the participant on a failed submit and retries successfully", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" onDone={onDone} />);

    await rankAllItems();
    for (const [group, rating] of [
      [/satisfied are you with the group's final ranking/, "6"],
      [/reached its decision fairly/, "5"],
      [/views were heard/, "7"],
    ] as const) {
      await userEvent.click(
        within(screen.getByRole("group", { name: group })).getByRole("radio", {
          name: rating,
        }),
      );
    }

    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    // Failed submit: the answers are NOT dropped and the flow does not end.
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't submit/i);
    expect(onDone).not.toHaveBeenCalled();

    // Retry goes through (fetch is ok again) and finishes the flow.
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
