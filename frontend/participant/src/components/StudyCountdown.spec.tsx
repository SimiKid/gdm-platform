import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudyCountdown from "./StudyCountdown";

afterEach(() => vi.useRealTimers());

describe("StudyCountdown", () => {
  it("expires once using wall time after a suspended tab and uses the latest callback", () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 300_000;
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<StrictMode><StudyCountdown deadline={deadline} label="Time remaining" onExpire={first} /></StrictMode>);
    expect(screen.getByRole("timer")).toHaveTextContent("5:00");
    act(() => vi.advanceTimersByTime(60_000));
    view.rerender(<StrictMode><StudyCountdown deadline={deadline} label="Time remaining" onExpire={latest} /></StrictMode>);
    expect(screen.getByRole("timer")).toHaveTextContent("4:00");
    vi.setSystemTime(deadline + 30_000);
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole("timer")).toHaveTextContent("0:00");
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});
