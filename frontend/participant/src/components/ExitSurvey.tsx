import { useState } from "react";
import type {
  CompleteParticipantResponse,
  PublicSession,
  Survey,
} from "@gdm/shared";
import { httpSessionManager } from "../study/sessionClient";
import StudyShell from "./StudyShell";
import RankingBoard from "./RankingBoard";
import Likert from "./Likert";
import LikertMatrix from "./LikertMatrix";

interface Props {
  session: PublicSession;
  participantId: string;
  /** The group's final ranking order, used as the pre-filled default. */
  groupRanking?: string[];
  /** Called once the exit survey is submitted and the session is completed. */
  onDone: (completion: CompleteParticipantResponse) => void;
  onWithdraw?: () => void;
}

type ExitStep = "ranking" | "reflection2" | "reflection3";

const CONFIDENCE_OPTIONS = [
  { value: "1", label: "Not confident at all" },
  { value: "2", label: "Rather not confident" },
  { value: "3", label: "Neither" },
  { value: "4", label: "Rather confident" },
  { value: "5", label: "Very confident" },
];

const GROUP_DYNAMICS_ITEMS = [
  { key: "groupConsidered", label: "The group genuinely considered everyone's contribution." },
  { key: "groupBalanced", label: "The group discussion felt balanced." },
  { key: "attentionCheck1", label: "This is an attention check. Please check \"disagree strongly\"." },
  { key: "groupDominated", label: "Some participants dominated the discussion more than others." },
  { key: "feltTeam", label: "I felt like part of a team during the task." },
  { key: "comfortableAgain", label: "I would be comfortable working with this group again." },
];

const PSYCH_SAFETY_ITEMS = [
  { key: "safeSpeakUp", label: "I felt safe to speak up with my thoughts in this group." },
  { key: "raiseConcerns", label: "I was able to raise concerns without fear of judgment." },
  { key: "contradicted", label: "I added my thoughts even if they contradicted those of my group members." },
  { key: "attentionCheck2", label: "This is an attention check. Please check \"agree moderately\"." },
  { key: "contributionSerious", label: "I felt my contribution was taken seriously." },
  { key: "contributionInfluenced", label: "I felt that my contributions influenced the final ranking." },
  { key: "heldBack", label: "There were things I wanted to contribute but held back." },
];

const BOT_PERCEPTION_ITEMS = [
  { key: "botIntrusive", label: "The bot intervention felt intrusive to me." },
  { key: "botHelpful", label: "The bot interventions felt helpful to me." },
  { key: "botAppropriate", label: "The bot intervened appropriately in our discussion." },
  { key: "botObserved", label: "The bot made me feel somehow observed." },
  { key: "botSupport", label: "I would like to receive such bot support in meetings." },
];

const AGREE_SCALE_5 = [
  "Disagree strongly",
  "Disagree moderately",
  "Neither disagree nor agree",
  "Agree moderately",
  "Agree strongly",
];

/**
 * Exit Survey — shown when the discussion timer runs out.
 *
 * Step 1: final individual ranking adjustment.
 * Step 2: task confidence + group dynamics matrix.
 * Step 3: psychological safety matrix + bot perception matrix, then submit.
 */
export default function ExitSurvey({
  session,
  participantId,
  groupRanking,
  onDone,
  onWithdraw,
}: Props) {
  const items = session.rankingTask.items;
  const [step, setStep] = useState<ExitStep>("ranking");

  // Step 1: ranking
  const [ranked, setRanked] = useState<string[]>(groupRanking ?? []);

  // Step 2: confidence + group dynamics
  const [confidence, setConfidence] = useState("");
  const [groupDynamics, setGroupDynamics] = useState<Record<string, string>>(
    {},
  );

  // Step 3: psych safety + bot perception
  const [psychSafety, setPsychSafety] = useState<Record<string, string>>({});
  const [botPerception, setBotPerception] = useState<Record<string, string>>(
    {},
  );

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  const allRanked = ranked.length === items.length;
  const step2Ready =
    confidence !== "" &&
    GROUP_DYNAMICS_ITEMS.every((item) => groupDynamics[item.key]);
  const step3Ready =
    PSYCH_SAFETY_ITEMS.every((item) => psychSafety[item.key]) &&
    BOT_PERCEPTION_ITEMS.every((item) => botPerception[item.key]);

  async function submit() {
    setSubmitting(true);
    setSubmitError(false);
    const answers: Record<string, string | number | boolean | string[]> = {
      finalRanking: ranked,
      taskConfidence: Number(confidence),
    };
    for (const item of GROUP_DYNAMICS_ITEMS) {
      answers[item.key] = Number(groupDynamics[item.key]);
    }
    for (const item of PSYCH_SAFETY_ITEMS) {
      answers[item.key] = Number(psychSafety[item.key]);
    }
    for (const item of BOT_PERCEPTION_ITEMS) {
      answers[item.key] = Number(botPerception[item.key]);
    }
    const survey: Survey = {
      answers,
      submittedAt: new Date().toISOString(),
    };
    try {
      await httpSessionManager.submitSurvey({
        sessionId: session.id,
        participantId,
        kind: "exit",
        survey,
      });
      const completion = await httpSessionManager.completeParticipant(
        session.id,
        participantId,
      );
      onDone(completion);
    } catch {
      setSubmitError(true);
      setSubmitting(false);
    }
  }

  // ── Step 1: Final ranking ─────────────────────────────────────────────
  if (step === "ranking") {
    return (
      <StudyShell onWithdraw={onWithdraw}>
        <div className="study-card">
          <h1>Almost done!</h1>

          <p>
            Before moving to the final questionnaire,{" "}
            <strong>
              we want to provide you a final opportunity to adjust your personal
              ranking.
            </strong>
          </p>
          <p>
            Once again, this is your own view! You can reflect on your initial
            ranking or the ranking you reached with the group. We are solely
            interested in your personal view!
          </p>
          <p>
            Once you are done, please click submit. The time limit for your
            final ranking is 2 minutes.
          </p>

          <RankingBoard
            items={items}
            ranked={ranked}
            onChange={setRanked}
            poolBelow={!!groupRanking?.length}
          />

          <div className="card-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!allRanked}
              onClick={() => setStep("reflection2")}
            >
              Submit my final ranking
            </button>
            {!allRanked && (
              <p className="action-hint">
                Rank all {items.length} items to submit (
                {items.length - ranked.length} remaining).
              </p>
            )}
          </div>
        </div>
      </StudyShell>
    );
  }

  // ── Step 2: Task confidence + group dynamics ──────────────────────────
  if (step === "reflection2") {
    return (
      <StudyShell onWithdraw={onWithdraw}>
        <div className="study-card">
          <h1>Final Task Reflection</h1>
          <p>
            Finally, we ask you to reflect on your experience in the group by
            answering the questions below.
          </p>

          <Likert
            name="confidence"
            legend="How confident are you that your group was able to submit the correct ranking?"
            options={CONFIDENCE_OPTIONS}
            value={confidence}
            onChange={setConfidence}
          />

          <LikertMatrix
            name="group-dynamics"
            legend="To what extent do you agree with the following statements:"
            items={GROUP_DYNAMICS_ITEMS}
            scaleLabels={AGREE_SCALE_5}
            values={groupDynamics}
            onChange={(key, value) =>
              setGroupDynamics((prev) => ({ ...prev, [key]: value }))
            }
          />

          <div className="card-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!step2Ready}
              onClick={() => setStep("reflection3")}
            >
              Continue
            </button>
            {!step2Ready && (
              <p className="action-hint">
                Please answer all questions to continue.
              </p>
            )}
          </div>
        </div>
      </StudyShell>
    );
  }

  // ── Step 3: Psychological safety + bot perception ─────────────────────
  return (
    <StudyShell onWithdraw={onWithdraw}>
      <div className="study-card">
        <h1>Final Task Reflection</h1>
        <p>
          Finally, we ask you to reflect on your experience in the group by
          answering the questions below.
        </p>

        <LikertMatrix
          name="psych-safety"
          legend="To what extent do you agree with the following statements:"
          items={PSYCH_SAFETY_ITEMS}
          scaleLabels={AGREE_SCALE_5}
          values={psychSafety}
          onChange={(key, value) =>
            setPsychSafety((prev) => ({ ...prev, [key]: value }))
          }
        />

        <LikertMatrix
          name="bot-perception"
          legend="The bot intervention"
          items={BOT_PERCEPTION_ITEMS}
          scaleLabels={AGREE_SCALE_5}
          values={botPerception}
          onChange={(key, value) =>
            setBotPerception((prev) => ({ ...prev, [key]: value }))
          }
        />

        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={!step3Ready || submitting}
          >
            {submitting
              ? "Submitting…"
              : submitError
                ? "Try again"
                : "Submit"}
          </button>
          {submitError && (
            <p className="error" role="alert">
              We couldn't submit your answers. Please check your connection and
              try again. Your input is still here.
            </p>
          )}
          {!step3Ready && (
            <p className="action-hint">
              Please answer all questions to submit.
            </p>
          )}
        </div>
      </div>
    </StudyShell>
  );
}
