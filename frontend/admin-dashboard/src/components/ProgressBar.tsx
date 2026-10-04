/** Completed share of a goal in percent, capped at 100 (0 without a goal). */
export function progressPercent(completed: number, goal: number): number {
  return goal > 0 ? Math.min(100, (completed / goal) * 100) : 0;
}

/** Thin completed-vs-goal bar used by the tracking and recruiting tables. */
export default function ProgressBar({ completed, goal }: { completed: number; goal: number }) {
  return (
    <div className="bar">
      <span style={{ width: `${progressPercent(completed, goal)}%` }} />
    </div>
  );
}
