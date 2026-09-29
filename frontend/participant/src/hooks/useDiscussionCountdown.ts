import { useEffect, useState } from "react";

/** Countdown to the end of the discussion, in ms (null if no timer). */
export function useDiscussionCountdown(
  startedAt?: string,
  durationMinutes?: number,
): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt || !durationMinutes) return;
    const end = new Date(startedAt).getTime() + durationMinutes * 60_000;
    const tick = () => setRemaining(Math.max(0, end - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt, durationMinutes]);
  return remaining;
}
