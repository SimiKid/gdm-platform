import { useEffect, useRef, useState } from "react";
import { formatMmSs, MOON_SURVIVAL, MOON_SURVIVAL_BRIEFING } from "@gdm/shared";
import RankingBoard from "./RankingBoard";

export interface RankingTaskAnswers {
  /** Item ids, most to least important. */
  individualRanking: string[];
  /** False when the 5-minute timer expired before every item was ranked. */
  rankingCompleted: boolean;
  rankingSecondsUsed: number;
}

interface Props {
  onComplete: (answers: RankingTaskAnswers) => void;
  /** Participants per group; null (unknown) keeps the wording number-free. */
  groupSize?: number | null;
}

const TASK_SECONDS = 5 * 60;
const ITEMS = MOON_SURVIVAL.items;

/**
 * Page 4 — the individual ranking task ("Survival on the Moon").
 *
 * Submit unlocks once all task items are ranked. A 5-minute countdown runs at
 * the top; when it expires the current state is submitted as-is (any leftover
 * items are appended in their shown order and the ranking is flagged
 * incomplete).
 */
export default function RankingTaskPage({ onComplete, groupSize = null }: Props) {
  const [ranked, setRanked] = useState<string[]>([]);
  const remaining = ITEMS.length - ranked.length;

  const [secondsLeft, setSecondsLeft] = useState(TASK_SECONDS);
  const endRef = useRef<number | null>(null);

  const submittedRef = useRef(false);

  // Keep the latest ranking and callback in refs so the timer, started once on
  // mount, submits fresh data.
  const rankedRef = useRef(ranked);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    rankedRef.current = ranked;
    onCompleteRef.current = onComplete;
  });

  function doComplete(order: string[], completed: boolean, secondsUsed: number) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onCompleteRef.current({
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
        const r = rankedRef.current;
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
        aria-label={`Time remaining: ${formatMmSs(secondsLeft)}`}
      >
        <span aria-hidden="true">⏱</span> {formatMmSs(secondsLeft)}
        <span className="task-timer-caption">time remaining</span>
      </div>

      <div className="study-card">
        <p>
          Before you meet the group to solve the task together, we ask you to
          solve it individually. Once you are done, you will be directed to enter
          the group chat environment where you have time to discuss the task in
          your group{groupSize === null ? "" : ` of ${groupSize}`}.
        </p>

        <h1>Study Task Description</h1>
        <div
          // Trusted, repository-authored briefing shared with the chat panel.
          dangerouslySetInnerHTML={{ __html: MOON_SURVIVAL_BRIEFING.html }}
        />

        <h2>
          Rank the items below by importance for reaching the mothership. Most
          important item = 1, least important item = {ITEMS.length} ({remaining}{" "}
          remaining).
        </h2>

        <RankingBoard items={ITEMS} ranked={ranked} onChange={setRanked} />

        <p>
          <strong>Please Note:</strong>
        </p>
        <p>
          We are interested in your personal judgment.{" "}
          <strong>
            Please work on your own and rely only on your own reasoning: do not
            search the internet or use other aids.
          </strong>{" "}
          Outside information would make your data unusable for this research.
        </p>
        <p>
          <strong>
            You have 5 minutes to complete your personal ranking.
          </strong>{" "}
          You may submit earlier once every item is ranked.
        </p>

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
