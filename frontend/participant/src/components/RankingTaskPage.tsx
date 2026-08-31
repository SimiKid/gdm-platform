import { useEffect, useRef, useState } from "react";
import { MOON_SURVIVAL, MOON_SURVIVAL_BRIEFING } from "@gdm/shared";
import Likert from "./Likert";
import RankingBoard from "./RankingBoard";

/** 1..n numeric scale as Likert options. */
function numericScale(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
}

export interface RankingTaskAnswers {
  /** Item ids, most to least important. */
  individualRanking: string[];
  /** False when the 10-minute timer expired before every item was ranked. */
  rankingCompleted: boolean;
  rankingSecondsUsed: number;
  teamworkFrequency: string;
  chatComfort: number;
  topicFamiliarity: number;
}

interface Props {
  onComplete: (answers: RankingTaskAnswers) => void;
}

const TASK_SECONDS = 10 * 60;
const ITEMS = MOON_SURVIVAL.items;

const TEAMWORK_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "rarely", label: "Rarely" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
  { value: "daily", label: "Daily" },
];

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Page 3 — the individual ranking task ("Survival on the Moon").
 *
 * Submit unlocks once all task items are ranked. A 10-minute countdown runs at
 * the top; when it expires the current state is submitted as-is (any leftover
 * items are appended in their shown order and the ranking is flagged
 * incomplete). After submitting, a few short follow-up questions are asked
 * without time pressure.
 */
export default function RankingTaskPage({ onComplete }: Props) {
  const [ranked, setRanked] = useState<string[]>([]);
  const remaining = ITEMS.length - ranked.length;

  const [secondsLeft, setSecondsLeft] = useState(TASK_SECONDS);
  const endRef = useRef<number | null>(null);

  // The submitted ranking result; set once, then the follow-up questions show.
  const [result, setResult] = useState<{
    order: string[];
    completed: boolean;
    secondsUsed: number;
  } | null>(null);

  const [teamwork, setTeamwork] = useState("");
  const [chatComfort, setChatComfort] = useState("");
  const [familiarity, setFamiliarity] = useState("");

  // Keep the latest state in refs so the timeout handler submits fresh data.
  const stateRef = useRef({ ranked, result });
  stateRef.current = { ranked, result };

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
        const { ranked: r, result: res } = stateRef.current;
        if (!res) {
          // Time is up: submit what we have, leftovers in shown order.
          const leftovers = ITEMS
            .map((i) => i.id)
            .filter((itemId) => !r.includes(itemId));
          setResult({
            order: [...r, ...leftovers],
            completed: leftovers.length === 0,
            secondsUsed: TASK_SECONDS,
          });
        }
      }
    };
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  function submitRanking() {
    if (result) return;
    setResult({
      order: ranked,
      completed: true,
      secondsUsed: TASK_SECONDS - secondsLeft,
    });
  }

  const questionsReady = teamwork && chatComfort && familiarity;
  const timerLow = secondsLeft <= 2 * 60;

  // ── Sub-step 2: follow-up questions (no time pressure) ────────────────
  if (result) {
    return (
      <div className="study-card">
        <h1>A few more questions</h1>
        <p>Your ranking has been saved. Please answer these before the group phase.</p>

        <Likert
          name="teamwork"
          legend="How often do you work on tasks in teams?"
          options={TEAMWORK_OPTIONS}
          value={teamwork}
          onChange={setTeamwork}
        />

        <Likert
          name="chat-comfort"
          legend="How comfortable are you communicating via text chat?"
          options={numericScale(7)}
          value={chatComfort}
          onChange={setChatComfort}
          anchors={["1 = not at all comfortable", "7 = very comfortable"]}
        />

        <Likert
          name="familiarity"
          legend="How familiar are you with spaceflight or survival-related topics?"
          options={numericScale(7)}
          value={familiarity}
          onChange={setFamiliarity}
          anchors={["1 = not at all familiar", "7 = very familiar"]}
        />

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!questionsReady}
            onClick={() =>
              onComplete({
                individualRanking: result.order,
                rankingCompleted: result.completed,
                rankingSecondsUsed: result.secondsUsed,
                teamworkFrequency: teamwork,
                chatComfort: Number(chatComfort),
                topicFamiliarity: Number(familiarity),
              })
            }
          >
            Continue
          </button>
          {!questionsReady && (
            <p className="action-hint">Please answer all questions to continue.</p>
          )}
        </div>
      </div>
    );
  }

  // ── Sub-step 1: the timed ranking task ────────────────────────────────
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
          className="briefing-body"
          // Trusted, locally-authored briefing HTML from @gdm/shared.
          dangerouslySetInnerHTML={{ __html: MOON_SURVIVAL_BRIEFING.html }}
        />
        <p>
          Below are the {ITEMS.length} items that survived the landing intact.
          Rank them by importance for reaching the rendezvous point:{" "}
          <strong>1 = most important, {ITEMS.length} = least important</strong>.
        </p>

        <RankingBoard items={ITEMS} ranked={ranked} onChange={setRanked} />

        <aside className="notice-box">
          <h2>Important</h2>
          <ul>
            <li>Work on your own and rely only on your own reasoning.</li>
            <li>
              Please do not search the internet or use other aids. We are
              interested in your personal judgment; outside information would
              make your data unusable for this research.
            </li>
            <li>
              You have 10 minutes. You may submit earlier once every item is
              ranked.
            </li>
          </ul>
        </aside>

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={remaining > 0}
            onClick={submitRanking}
          >
            Submit my ranking
          </button>
          {remaining > 0 && (
            <p className="action-hint">
              Rank all {ITEMS.length} items to submit ({remaining} remaining).
            </p>
          )}
        </div>
      </div>
    </>
  );
}
