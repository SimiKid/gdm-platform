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

interface Props {
  /** Called with the assembled entry survey (incl. the individual ranking). */
  onComplete: (survey: Survey) => void;
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
 * → individual ranking task (10-min timer) → group phase instructions.
 * "Join chat" hands the assembled entry survey up to App, which moves
 * on to the waiting room.
 */
export default function Survey({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("consent");
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
    <StudyShell step={STEP_NUMBER[step]}>
      {step === "consent" && <ConsentPage onBegin={() => setStep("about")} />}

      {step === "about" && (
        <AboutYouPage
          onContinue={(answers) => {
            setAbout(answers);
            setStep("attitudes");
          }}
        />
      )}

      {step === "attitudes" && (
        <AttitudesPage
          onContinue={(answers) => {
            setAttitudes(answers);
            setStep("task");
          }}
        />
      )}

      {step === "task" && (
        <RankingTaskPage
          onComplete={(answers) => {
            setTask({ ...answers });
            setStep("group");
          }}
        />
      )}

      {step === "group" && <GroupIntroPage onJoin={finish} />}
    </StudyShell>
  );
}
