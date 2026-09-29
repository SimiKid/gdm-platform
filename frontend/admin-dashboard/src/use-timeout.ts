import { useCallback, useEffect, useRef } from "react";

/**
 * A single rescheduling timer bound to the component: scheduling again
 * replaces the pending callback, and unmounting cancels it, so transient
 * "Saved ✓" / "Copied ✓" flashes never fire after their component is gone.
 */
export function useTimeout(): (callback: () => void, ms: number) => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((callback: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(callback, ms);
  }, []);
}
