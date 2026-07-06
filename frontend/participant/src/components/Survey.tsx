import { useState } from "react";
import type { Survey } from "@gdm/shared";
import StudyShell from "./StudyShell";
import ConsentPage from "./ConsentPage";
import AboutYouPage from "./AboutYouPage";
import type { AboutYouAnswers } from "./AboutYouPage";
import RankingTaskPage from "./RankingTaskPage";
import GroupIntroPage from "./GroupIntroPage";

interface Props {
  /** Called with the assembled entry survey (incl. the individual ranking). */
  onComplete: (survey: Survey) => void;
}

type Step = "consent" | "about" | "task" | "group";
const STEP_NUMBER: Record<Step, 1 | 2 | 3 | 4> = {
  consent: 1,
  about: 2,
  task: 3,
  group: 4,
};

/**
 * The pre-chat participant flow (pages 1–4):
 * informed consent → about you → individual ranking task (10-min timer)
 * → group phase instructions. "Join chat" hands the assembled entry survey
 * up to App, which moves on to the waiting room.
 */
export default function Survey({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("consent");
  const [about, setAbout] = useState<AboutYouAnswers | null>(null);
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
