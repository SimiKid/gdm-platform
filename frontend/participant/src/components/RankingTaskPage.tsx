import { useEffect, useRef, useState } from "react";
import { MOON_SURVIVAL, MOON_SURVIVAL_BRIEFING } from "@gdm/shared";
import RankingBoard from "./RankingBoard";

export interface RankingTaskAnswers {
  /** Item ids, most to least important. */
  individualRanking: string[];
  /** False when the 10-minute timer expired before every item was ranked. */
  rankingCompleted: boolean;
  rankingSecondsUsed: number;
}

interface Props {
  onComplete: (answers: RankingTaskAnswers) => void;
}

const TASK_SECONDS = 10 * 60;
const ITEMS = MOON_SURVIVAL.items;

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Page 4 — the individual ranking task ("Survival on the Moon").
 *
 * Submit unlocks once all task items are ranked. A 10-minute countdown runs at
 * the top; when it expires the current state is submitted as-is (any leftover
 * items are appended in their shown order and the ranking is flagged
 * incomplete).
 */
export default function RankingTaskPage({ onComplete }: Props) {
  const [ranked, setRanked] = useState<string[]>([]);
  const remaining = ITEMS.length - ranked.length;

  const [secondsLeft, setSecondsLeft] = useState(TASK_SECONDS);
  const endRef = useRef<number | null>(null);

  const submittedRef = useRef(false);

  // Keep the latest state in refs so the timeout handler submits fresh data.
  const stateRef = useRef({ ranked });
  stateRef.current = { ranked };

  function doComplete(order: string[], completed: boolean, secondsUsed: number) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onComplete({
      individualRanking: order,
      rankingCompleted: completed,
      rankingSecondsUsed: secondsUsed,
    });
  }

  useEffect(() => {
    endRef.current = Date.now() + TASK_SECONDS * 1000;
    const tick = () => {
      const left = Math.max(
        0,
        Math.round((endRef.current! - Date.now()) / 1000),
      );
      setSecondsLeft(left);
      if (left === 0) {
        clearInterval(id);
        const { ranked: r } = stateRef.current;
        // Time is up: submit what we have, leftovers in shown order.
        const leftovers = ITEMS
          .map((i) => i.id)
          .filter((itemId) => !r.includes(itemId));
        doComplete(
          [...r, ...leftovers],
          leftovers.length === 0,
          TASK_SECONDS,
        );
      }
    };
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submitRanking() {
    doComplete(ranked, true, TASK_SECONDS - secondsLeft);
  }

  const timerLow = secondsLeft <= 2 * 60;

  return (
    <>
      <div
        className={`task-timer ${timerLow ? "low" : ""}`}
        role="timer"
        aria-label={`Time remaining: ${formatSeconds(secondsLeft)}`}
      >
        <span aria-hidden="true">⏱</span> {formatSeconds(secondsLeft)}
        <span className="task-timer-caption">time remaining</span>
      </div>

      <div className="study-card">
        <h1>Your Task: Survival on the Moon</h1>
        <div
          className="task-briefing"
          // The briefing is a static HTML blob authored in shared/src/tasks.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: MOON_SURVIVAL_BRIEFING }}
        />

        <h2>
          Rank all {ITEMS.length} items to submit ({remaining} remaining).
        </h2>
        <RankingBoard items={ITEMS} ranked={ranked} onChange={setRanked} />

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={remaining > 0}
            onClick={submitRanking}
          >
            Submit my ranking
          </button>
        </div>
      </div>
    </>
  );
}
