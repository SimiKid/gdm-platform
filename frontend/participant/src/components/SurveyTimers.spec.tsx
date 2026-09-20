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

function finishEntry() {
  act(() => vi.advanceTimersByTime(300_000)); // existing individual ranking timer
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Join chat" }));
}

describe("entry questionnaire timer", () => {
  it("starts after consent and preserves incomplete demographics at expiry", () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);
    act(() => vi.advanceTimersByTime(600_000));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    consent();
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    fireEvent.change(screen.getByLabelText("How old are you?"), { target: { value: "30" } });
    act(() => vi.advanceTimersByTime(299_000));
    expect(screen.getByRole("timer")).toHaveTextContent("0:01");
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText(/Task: Survival on the Moon/)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    finishEntry();
    expect(onComplete).toHaveBeenCalledOnce();
    const answers = onComplete.mock.calls[0][0].answers;
    expect(answers).toMatchObject({ age: 30, entryQuestionnaireTimedOut: true });
    expect(answers).not.toHaveProperty("gender");
    expect(answers).not.toHaveProperty("gaais1");
  });

  it("shares the five minutes across demographic and attitudes pages", () => {
    const onComplete = vi.fn();
    render(<Survey onComplete={onComplete} />);
    consent();
    fireEvent.change(screen.getByLabelText("How old are you?"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("radio", { name: "Woman" }));
    fireEvent.click(screen.getByRole("radio", { name: "Bachelor's degree" }));
    fireEvent.click(screen.getByRole("radio", { name: "Fluent (advanced)" }));
    act(() => vi.advanceTimersByTime(120_000));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("timer")).toHaveTextContent("3:00");
    fireEvent.click(screen.getAllByRole("radio", { name: /: Disagree strongly$/i })[0]);
    act(() => vi.advanceTimersByTime(180_000));
    finishEntry();
    const answers = onComplete.mock.calls[0][0].answers;
    expect(answers).toMatchObject({ gaais1: 1, age: 30, entryQuestionnaireTimedOut: true });
    expect(answers).not.toHaveProperty("gaais2");
    expect(answers).not.toHaveProperty("chatComfort");
  });

  it("does not bypass a reported underage answer on expiry", () => {
    const onIneligible = vi.fn();
    render(<Survey onComplete={vi.fn()} onIneligible={onIneligible} />);
    consent();
    fireEvent.change(screen.getByLabelText("How old are you?"), { target: { value: "17" } });
    act(() => vi.advanceTimersByTime(300_000));
    expect(onIneligible).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Task: Survival on the Moon/)).not.toBeInTheDocument();
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
