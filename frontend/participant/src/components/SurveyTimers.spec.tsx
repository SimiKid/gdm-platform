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
    expect(screen.queryByText(/Task: Survival on the Moon/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Woman" }));
    fireEvent.click(screen.getByRole("radio", { name: "Bachelor's degree" }));
    fireEvent.click(screen.getByRole("radio", { name: "Fluent (advanced)" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    expect(screen.queryByText(/Task: Survival on the Moon/)).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

const session = { id: "s", rankingTask: MOON_SURVIVAL } as PublicSession;
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

describe("exit timers", () => {
  it("keeps an unfinished ranking after two minutes and submits partial answers after five more", async () => {
    const fetchMock = mockApi();
    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" onDone={onDone} />);
    expect(screen.getByRole("timer")).toHaveTextContent("2:00");
    fireEvent.click(screen.getAllByRole("button", { name: /^Add .* to the ranking$/ })[0]);
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    fireEvent.click(screen.getByRole("radio", { name: "Rather confident" }));
    await act(async () => vi.advanceTimersByTime(300_000));
    expect(onDone).toHaveBeenCalledOnce();
    const answers = savedAnswers(fetchMock);
    expect(answers).toMatchObject({ taskConfidence: 4, finalRankingTimedOut: true, finalRankingCompleted: false, exitQuestionnaireTimedOut: true });
    expect(answers.finalRankingPartial).toHaveLength(1);
    expect(answers).not.toHaveProperty("finalRanking");
    expect(answers).not.toHaveProperty("groupConsidered");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("shares the questionnaire deadline across reflection pages and retains all entered answers", async () => {
    const fetchMock = mockApi();
    render(<ExitSurvey session={session} participantId="p" groupRanking={order} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Submit my final ranking" }));
    fireEvent.click(screen.getByRole("radio", { name: "Rather confident" }));
    screen.getAllByRole("radio", { name: /: Disagree strongly$/i }).forEach(radio => fireEvent.click(radio));
    act(() => vi.advanceTimersByTime(120_000));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("timer")).toHaveTextContent("3:00");
    fireEvent.click(screen.getAllByRole("radio", { name: /: Disagree strongly$/i })[0]);
    await act(async () => vi.advanceTimersByTime(180_000));
    expect(savedAnswers(fetchMock)).toMatchObject({ finalRanking: order, taskConfidence: 4, groupConsidered: 1, safeSpeakUp: 1 });
    expect(savedAnswers(fetchMock)).not.toHaveProperty("raiseConcerns");
  });

  it("allows retrying a failed automatic submission without duplicating completion", async () => {
    const fetchMock = mockApi();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const onDone = vi.fn();
    render(<ExitSurvey session={session} participantId="p" groupRanking={order} onDone={onDone} />);
    act(() => vi.advanceTimersByTime(120_000));
    await act(async () => vi.advanceTimersByTime(300_000));
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't submit/);
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(onDone).toHaveBeenCalledOnce();
    expect(savedAnswers(fetchMock).finalRanking).toEqual(order);
    expect(savedAnswers(fetchMock)).not.toHaveProperty("taskConfidence");
  });
});
