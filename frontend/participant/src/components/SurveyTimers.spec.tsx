import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOON_SURVIVAL } from "@gdm/shared";
import type { PublicSession } from "@gdm/shared";
import Survey from "./Survey";
import ExitSurvey from "./ExitSurvey";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function consent() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /continue to the consent form/i }));
  screen.getAllByRole("checkbox").forEach(box => fireEvent.click(box));
  fireEvent.click(screen.getByRole("button", { name: "Begin study" }));
}

describe("entry questionnaire", () => {
  it("is untimed: no countdown and no auto-advance off the demographic pages", () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);
    consent();
    // The only remaining entry timer belongs to the ranking task, which is
    // two pages away.
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("How old are you?"), { target: { value: "30" } });
    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.getByLabelText("How old are you?")).toBeInTheDocument();
    expect(screen.queryByText("Study Task Description")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Woman" }));
    fireEvent.click(screen.getByRole("radio", { name: "Bachelor's degree" }));
    fireEvent.click(screen.getByRole("radio", { name: "Fluent (advanced)" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByText("Study Task Description")).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

const session = {
  id: "s",
  condition: { config: {} },
  rankingTask: MOON_SURVIVAL,
} as PublicSession;
const order = MOON_SURVIVAL.items.map(item => item.id);
function mockApi() {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ completedAt: "now", compensationUrl: "" }) }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function savedAnswers(fetchMock: ReturnType<typeof mockApi>) {
  const call = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([url]) => url.includes("/surveys"));
  return JSON.parse(call![1].body as string).survey.answers;
}

describe("exit survey", () => {
  it("is untimed end to end and keeps every answer through to submit", async () => {
    const fetchMock = mockApi();
    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" groupRanking={order} onDone={onDone} />);

    // 1/2 — the final ranking: no countdown, and waiting advances nothing.
    expect(screen.getByText("Final Task Reflection (1/3)")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.getByText("Final Task Reflection (1/3)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Submit my final ranking" }));

    // 2/2 — confidence + group dynamics, also untimed.
    expect(screen.getByText("Final Task Reflection (2/3)")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Rather confident" }));
    screen.getAllByRole("radio", { name: /: Disagree strongly$/i }).forEach(radio => fireEvent.click(radio));
    act(() => vi.advanceTimersByTime(600_000));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Last page — psychological safety + bot perception, submitted by hand.
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    screen.getAllByRole("radio", { name: /: Disagree strongly$/i }).forEach(radio => fireEvent.click(radio));
    act(() => vi.advanceTimersByTime(600_000));
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit" })));

    expect(onDone).toHaveBeenCalledOnce();
    expect(savedAnswers(fetchMock)).toMatchObject({
      finalRanking: order,
      finalRankingCompleted: true,
      finalRankingTimedOut: false,
      exitQuestionnaireTimedOut: false,
      taskConfidence: 4,
      groupConsidered: 1,
      safeSpeakUp: 1,
    });
  });
});
