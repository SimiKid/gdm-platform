import { useRef, useState } from "react";
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
import StudyCountdown from "./StudyCountdown";
import EtherpadTask from "./EtherpadTask";

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
  const etherpadMode = session.condition?.config.workspaceMode === "etherpad";
  const [exitPadId, setExitPadId] = useState<string | null>(null);
  const [step, setStep] = useState<ExitStep>("ranking");
  const [rankingDeadline] = useState(() => Date.now() + 2 * 60_000);
  const [questionnaireDeadline, setQuestionnaireDeadline] = useState<number | null>(null);
  const [rankingTimedOut, setRankingTimedOut] = useState(false);
  const [questionnaireTimedOut, setQuestionnaireTimedOut] = useState(false);
  const rankingFinished = useRef(false);
  const submissionInFlight = useRef(false);

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

  function finishRanking(timedOut = false) {
    if (rankingFinished.current) return;
    rankingFinished.current = true;
    setRankingTimedOut(timedOut);
    setQuestionnaireDeadline(Date.now() + 5 * 60_000);
    setStep("reflection2");
  }

  async function submit(timedOut = questionnaireTimedOut) {
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmitting(true);
    setSubmitError(false);
    const answers: Record<string, string | number | boolean | string[]> = {
      ...(etherpadMode ? { exitEtherpadId: exitPadId ?? "" } : { finalRankingCompleted: allRanked, finalRankingTimedOut: rankingTimedOut }),
      exitQuestionnaireTimedOut: timedOut,
    };
    // Keep an unfinished order without treating it as a scored, complete ranking.
    if (!etherpadMode) {
      if (allRanked) answers.finalRanking = ranked;
      else answers.finalRankingPartial = ranked;
    }
    if (confidence) answers.taskConfidence = Number(confidence);
    for (const item of GROUP_DYNAMICS_ITEMS) {
      if (groupDynamics[item.key]) answers[item.key] = Number(groupDynamics[item.key]);
    }
    for (const item of PSYCH_SAFETY_ITEMS) {
      if (psychSafety[item.key]) answers[item.key] = Number(psychSafety[item.key]);
    }
    for (const item of BOT_PERCEPTION_ITEMS) {
      if (botPerception[item.key]) answers[item.key] = Number(botPerception[item.key]);
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
      submissionInFlight.current = false;
      setSubmitError(true);
      setSubmitting(false);
    }
  }

  const questionnaireTimer = questionnaireDeadline !== null && (
    <>
      <StudyCountdown deadline={questionnaireDeadline} label="Exit questionnaire time remaining" onExpire={() => {
        setQuestionnaireTimedOut(true);
        void submit(true);
      }} />
      <p>You have 5 minutes across both reflection pages. When time runs out, the answers you have entered are submitted automatically.</p>
    </>
  );

  if (questionnaireTimedOut) {
    return (
      <StudyShell onWithdraw={onWithdraw}>
        <div className="study-card">
          <h1>Questionnaire time is up</h1>
          <p role="status">{submitting ? "Submitting your answers so far…" : "Your answers so far have been kept."}</p>
          {submitError && (
            <>
              <p className="error" role="alert">We couldn't submit your answers. Please check your connection and try again.</p>
              <button className="btn btn-primary" disabled={submitting} onClick={() => void submit(true)}>Try again</button>
            </>
          )}
        </div>
      </StudyShell>
    );
  }

  // ── Step 1: Final ranking ─────────────────────────────────────────────
  if (step === "ranking" && etherpadMode) {
    return <StudyShell onWithdraw={onWithdraw}><EtherpadTask phase="exit" sessionId={session.id} onComplete={pad => { setExitPadId(pad.id); finishRanking(); }} /></StudyShell>;
  }
  if (step === "ranking") {
    return (
      <StudyShell onWithdraw={onWithdraw}>
        <StudyCountdown deadline={rankingDeadline} label="Final ranking time remaining" onExpire={() => finishRanking(true)} />
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
            final ranking is 2 minutes. When time runs out, your current ranking
            is kept and you move to the final questionnaire.
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
              onClick={() => finishRanking()}
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
        {questionnaireTimer}
        {rankingTimedOut && <p role="status">Ranking time is up. Your current ranking has been kept.</p>}
        <div className="study-card">
          <h1>Final Task Reflection</h1>
          <p>
            Finally, we ask you to reflect on your experience in the group by
            answering the questions below.
          </p>

          <Likert
            name="confidence"
            legend={etherpadMode ? "How confident are you in the decision your group recorded?" : "How confident are you that your group was able to submit the correct ranking?"}
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
      {questionnaireTimer}
      <div className="study-card">
        <h1>Final Task Reflection</h1>
        <p>
          Finally, we ask you to reflect on your experience in the group by
          answering the questions below.
        </p>

        <LikertMatrix
          name="psych-safety"
          legend="To what extent do you agree with the following statements:"
              items={etherpadMode ? PSYCH_SAFETY_ITEMS.map(item => item.key === "contributionInfluenced" ? { ...item, label: "I felt that my contributions influenced the group's final response." } : item) : PSYCH_SAFETY_ITEMS}
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
            onClick={() => void submit()}
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
