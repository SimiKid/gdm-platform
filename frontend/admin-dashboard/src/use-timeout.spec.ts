import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeout } from "./use-timeout";

describe("useTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the latest scheduled callback once", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result } = renderHook(() => useTimeout());
    result.current(first, 1500);
    result.current(second, 1500);
    vi.advanceTimersByTime(1500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending callback on unmount", () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useTimeout());
    result.current(callback, 1500);
    unmount();
    vi.advanceTimersByTime(1500);
    expect(callback).not.toHaveBeenCalled();
  });
});
