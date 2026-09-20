import { useEffect, useRef, useState } from "react";

interface Props {
  deadline: number;
  label: string;
  onExpire: () => void;
}

/** An absolute deadline keeps the countdown accurate after a backgrounded tab. */
export default function StudyCountdown({ deadline, label, onExpire }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((deadline - Date.now()) / 1000)),
  );
  const onExpireRef = useRef(onExpire);
  const expiredDeadline = useRef<number | null>(null);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);

  useEffect(() => {
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0 && expiredDeadline.current !== deadline) {
        expiredDeadline.current = deadline;
        onExpireRef.current();
      }
    };
    tick();
    const interval = setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [deadline]);

  return (
    <div className={`task-timer ${secondsLeft <= 60 ? "low" : ""}`} role="timer" aria-label={label}>
      <span>{Math.floor(secondsLeft / 60)}:{(secondsLeft % 60).toString().padStart(2, "0")}</span>
      <span className="task-timer-caption">{label}</span>
    </div>
  );
}
