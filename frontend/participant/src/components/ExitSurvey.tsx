import { useState } from "react";
import type { PublicSession, Survey } from "@gdm/shared";
import { httpSessionManager } from "../study/sessionClient";
import StudyShell from "./StudyShell";
import RankingBoard from "./RankingBoard";
import Likert from "./Likert";

/** 1..n numeric scale as Likert options. */
function numericScale(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
}

interface Props {
  session: PublicSession;
  participantId: string;
  /** Called once the exit survey is submitted and the session is completed. */
  onDone: () => void;
}

/**
 * Page 5 — Exit Survey, shown when the discussion timer runs out.
 *
 * Part 1 asks for a fresh individual ranking (same widget as the individual
 * task, no timer, starting unranked so it reflects the participant's own
 * post-discussion view). Part 2 rates the group experience on 1–7 scales.
 * Submitting persists everything and completes the session.
 */
export default function ExitSurvey({ session, participantId, onDone }: Props) {
  const items = session.rankingTask.items;
  const [ranked, setRanked] = useState<string[]>([]);
  const [satisfaction, setSatisfaction] = useState("");
  const [fairness, setFairness] = useState("");
  const [feltHeard, setFeltHeard] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  async function submit() {
    setSubmitting(true);
    setSubmitError(false);
    const survey: Survey = {
      answers: {
        finalRanking: ranked,
        satisfaction: Number(satisfaction),
        fairness: Number(fairness),
        feltHeard: Number(feltHeard),
      },
      submittedAt: new Date().toISOString(),
    };
    try {
      await httpSessionManager.submitSurvey({
        sessionId: session.id,
        participantId,
        kind: "exit",
        survey,
      });
      await httpSessionManager.completeSession(session.id);
    } catch {
      // These answers are the primary post-discussion measure — never drop
      // them silently. Keep the participant here and let them retry.
      setSubmitError(true);
      setSubmitting(false);
      return;
    }
    onDone();
  }

  const allRanked = ranked.length === items.length;
  const ready = allRanked && satisfaction && fairness && feltHeard;

  return (
    <StudyShell>
      <div className="study-card">
        <h1>Almost done: A few final questions</h1>

        <h2>Part 1: Your final ranking</h2>
        <p>
          Now that the group discussion is over, please rank the 15 items one
          more time on your own. Your ranking may match the team's or differ
          from it. There is no right answer here; we are interested in your
          personal view after the discussion.
        </p>

        <RankingBoard items={items} ranked={ranked} onChange={setRanked} />

        <h2>Part 2: Your experience of the group discussion</h2>
        <p>
          Please rate the following statements (1 = strongly disagree, 7 =
          strongly agree):
        </p>

        <Likert
          name="satisfaction"
          legend="How satisfied are you with the group's final ranking?"
          options={numericScale(7)}
          value={satisfaction}
          onChange={setSatisfaction}
          anchors={["1 = very dissatisfied", "7 = very satisfied"]}
        />

        <Likert
          name="fairness"
          legend="The group reached its decision fairly."
          options={numericScale(7)}
          value={fairness}
          onChange={setFairness}
          anchors={["1 = strongly disagree", "7 = strongly agree"]}
        />

        <Likert
          name="felt-heard"
          legend="I felt my views were heard during the discussion."
          options={numericScale(7)}
          value={feltHeard}
          onChange={setFeltHeard}
          anchors={["1 = strongly disagree", "7 = strongly agree"]}
        />

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!ready || submitting}
          >
            {submitting ? "Submitting…" : submitError ? "Try again" : "Submit"}
          </button>
          {submitError && (
            <p className="error" role="alert">
              We couldn't submit your answers — please check your connection
              and try again. Your input is still here.
            </p>
          )}
          {!ready && (
            <p className="action-hint">
              {allRanked
                ? "Please rate all three statements to submit."
                : `Rank all 15 items to submit (${items.length - ranked.length} remaining).`}
            </p>
          )}
        </div>
      </div>
    </StudyShell>
  );
}
