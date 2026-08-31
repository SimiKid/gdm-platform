import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        completedAt: "2026-07-26T10:00:00.000Z",
        compensationUrl: "https://app.prolific.com/submissions/complete?cc=TEST",
      }),
    })),
  );
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

async function completeReflection2() {
  // Confidence
  await userEvent.click(
    screen.getByRole("radio", { name: "Rather confident" }),
  );
  // Group dynamics matrix — click "Disagree strongly" for all 6 rows
  const radios = screen.getAllByRole("radio", {
    name: /: Disagree strongly$/i,
  });
  for (const radio of radios) {
    await userEvent.click(radio);
  }
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

async function completeReflection3() {
  // Psych safety + bot perception — click "Disagree strongly" for all rows
  const radios = screen.getAllByRole("radio", {
    name: /: Disagree strongly$/i,
  });
  for (const radio of radios) {
    await userEvent.click(radio);
  }
}

describe("ExitSurvey", () => {
  it("walks ranking → reflection 2 → reflection 3, then submits", async () => {
    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" onDone={onDone} />);
    expect(screen.getByText(/Almost done!/)).toBeInTheDocument();

    // Step 1: ranking
    const submitRanking = screen.getByRole("button", {
      name: "Submit my final ranking",
    });
    expect(submitRanking).toBeDisabled();
    await rankAllItems();
    expect(submitRanking).toBeEnabled();
    await userEvent.click(submitRanking);

    // Step 2: reflection 2
    expect(screen.getByText(/Final Task Reflection/)).toBeInTheDocument();
    await completeReflection2();

    // Step 3: reflection 3
    expect(screen.getByText(/Final Task Reflection/)).toBeInTheDocument();
    await completeReflection3();

    const submit = screen.getByRole("button", { name: "Submit" });
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());

    // Verify the persisted exit survey carries ranking + new reflection fields.
    const surveyCall = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([url]) => String(url).includes("/surveys"),
    );
    const body = JSON.parse(surveyCall![1].body);
    expect(body.survey.answers.finalRanking).toHaveLength(10);
    expect(body.survey.answers.taskConfidence).toBe(4);
    expect(body.survey.answers.groupConsidered).toBe(1);
    expect(body.survey.answers.safeSpeakUp).toBe(1);
    expect(body.survey.answers.botIntrusive).toBe(1);
  });

  it("keeps the participant on a failed submit and retries successfully", async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" onDone={onDone} />);

    // Walk through all steps
    await rankAllItems();
    await userEvent.click(
      screen.getByRole("button", { name: "Submit my final ranking" }),
    );
    await completeReflection2();
    await completeReflection3();

    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    // Failed submit: answers are NOT dropped and the flow does not end.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't submit/i,
    );
    expect(onDone).not.toHaveBeenCalled();

    // Retry goes through (fetch is ok again) and finishes the flow.
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
