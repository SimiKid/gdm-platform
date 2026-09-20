import { useState } from "react";
import type { Survey } from "@gdm/shared";
import StudyShell from "./StudyShell";
import ConsentPage from "./ConsentPage";
import AboutYouPage from "./AboutYouPage";
import type { AboutYouAnswers } from "./AboutYouPage";
import AttitudesPage from "./AttitudesPage";
import type { AttitudesAnswers } from "./AttitudesPage";
import RankingTaskPage from "./RankingTaskPage";
import GroupIntroPage from "./GroupIntroPage";
import StudyCountdown from "./StudyCountdown";
import EtherpadTask from "./EtherpadTask";

interface Props {
  taskMode?: "ranking" | "etherpad";
  /** Called with the assembled entry survey (incl. the individual ranking). */
  onComplete: (survey: Survey) => void;
  onDecline?: () => void;
  onIneligible?: (reason: string) => void;
  onWithdraw?: () => void;
}

type Step = "consent" | "about" | "attitudes" | "task" | "group";
const STEP_NUMBER: Record<Step, 1 | 2 | 3 | 4> = {
  consent: 1,
  about: 2,
  attitudes: 2,
  task: 3,
  group: 4,
};

/**
 * The pre-chat participant flow (pages 1–5):
 * informed consent → about you (demographics) → about you (attitudes)
 * → individual ranking task (5-min timer) → group phase instructions.
 * "Join chat" hands the assembled entry survey up to App, which moves
 * on to the waiting room.
 */
export default function Survey({
  taskMode = "ranking",
  onComplete,
  onDecline,
  onIneligible,
  onWithdraw,
}: Props) {
  const [step, setStep] = useState<Step>("consent");
  const [questionnaireDeadline, setQuestionnaireDeadline] = useState<number | null>(null);
  const [questionnaireTimedOut, setQuestionnaireTimedOut] = useState(false);
  const [about, setAbout] = useState<AboutYouAnswers | null>(null);
  const [attitudes, setAttitudes] = useState<AttitudesAnswers | null>(null);
  const [task, setTask] = useState<Record<
    string,
    string | number | boolean | string[]
  > | null>(null);

  function finish() {
    const survey: Survey = {
      answers: {
        // All three boxes must be ticked before "Begin study" enables.
        consentAdult: true,
        consentInformed: true,
        consentParticipation: true,
        entryQuestionnaireTimedOut: questionnaireTimedOut,
        ...(about ?? {}),
        ...(attitudes ?? {}),
        ...(task ?? {}),
        groupInstructionsAcknowledged: true,
      },
      submittedAt: new Date().toISOString(),
    };
    onComplete(survey);
  }

  return (
    <StudyShell step={STEP_NUMBER[step]} onWithdraw={step === "consent" ? undefined : onWithdraw}>
      {(step === "about" || step === "attitudes") && questionnaireDeadline !== null && (
        <>
          <StudyCountdown deadline={questionnaireDeadline} label="Entry questionnaire time remaining" onExpire={() => setQuestionnaireTimedOut(true)} />
          <p>You have 5 minutes across both questionnaire pages. When time runs out, your answers so far are saved and you move to the {taskMode === "etherpad" ? "writing" : "ranking"} task.</p>
        </>
      )}
      {questionnaireTimedOut && step === "task" && (
        <p role="status">Questionnaire time is up. Your answers so far have been kept.</p>
      )}
      {step === "consent" && (
        <ConsentPage onBegin={() => {
          setQuestionnaireDeadline(Date.now() + 5 * 60_000);
          setStep("about");
        }} onDecline={onDecline} />
      )}

      {step === "about" && (
        <AboutYouPage
          onIneligible={onIneligible}
          expired={questionnaireTimedOut}
          onTimeout={(answers) => {
            setAbout(answers);
            setStep("task");
          }}
          onContinue={(answers) => {
            setAbout(answers);
            setStep("attitudes");
          }}
        />
      )}

      {step === "attitudes" && (
        <AttitudesPage
          expired={questionnaireTimedOut}
          onTimeout={(answers) => {
            setAttitudes(answers);
            setStep("task");
          }}
          onContinue={(answers) => {
            setAttitudes(answers);
            setStep("task");
          }}
        />
      )}

      {step === "task" && taskMode === "etherpad" && <EtherpadTask phase="entry" onComplete={pad => { setTask({ entryEtherpadId: pad.id }); setStep("group"); }} />}
      {step === "task" && taskMode !== "etherpad" && (
        <RankingTaskPage
          onComplete={(answers) => {
            setTask({ ...answers });
            setStep("group");
          }}
        />
      )}

      {step === "group" && <GroupIntroPage onJoin={finish} taskMode={taskMode} />}
    </StudyShell>
  );
}
