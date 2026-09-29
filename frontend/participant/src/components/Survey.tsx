import { useState } from "react";
import type { StudyInfoResponse, StudyTaskMode, Survey } from "@gdm/shared";
import StudyShell from "./StudyShell";
import ConsentPage from "./ConsentPage";
import { CONSENT_ITEMS } from "../study/consent";
import AboutYouPage from "./AboutYouPage";
import type { AboutYouAnswers } from "./AboutYouPage";
import AttitudesPage from "./AttitudesPage";
import type { AttitudesAnswers } from "./AttitudesPage";
import RankingTaskPage from "./RankingTaskPage";
import GroupIntroPage from "./GroupIntroPage";
import EtherpadTask from "./EtherpadTask";

interface Props {
  taskMode?: StudyTaskMode;
  /** Live group size / discussion length; null until loaded or if unknown. */
  studyInfo?: StudyInfoResponse | null;
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
 * informed consent → background info (demographics) → about you (attitudes)
 * → individual ranking task (5-min timer) → group phase instructions.
 * "Join chat" hands the assembled entry survey up to App, which moves
 * on to the waiting room.
 */
export default function Survey({
  taskMode = "ranking",
  studyInfo = null,
  onComplete,
  onDecline,
  onIneligible,
  onWithdraw,
}: Props) {
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
        // Every box must be ticked before "Begin study" enables.
        ...Object.fromEntries(
          CONSENT_ITEMS.map(({ key }) => [key, true] as const),
        ),
        // The entry questionnaire is untimed; kept so the answer schema still
        // matches the timed sessions recorded before this was removed.
        entryQuestionnaireTimedOut: false,
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
      {step === "consent" && (
        <ConsentPage
          groupSize={studyInfo?.groupSize ?? null}
          onBegin={() => setStep("about")}
          onDecline={onDecline}
        />
      )}

      {step === "about" && (
        <AboutYouPage
          onIneligible={onIneligible}
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

      {step === "task" && taskMode === "etherpad" && (
        <EtherpadTask
          phase="entry"
          onComplete={(pad) => {
            setTask({ entryEtherpadId: pad.id });
            setStep("group");
          }}
        />
      )}
      {step === "task" && taskMode !== "etherpad" && (
        <RankingTaskPage
          groupSize={studyInfo?.groupSize ?? null}
          onComplete={(answers) => {
            setTask({ ...answers });
            setStep("group");
          }}
        />
      )}

      {step === "group" && (
        <GroupIntroPage
          onJoin={finish}
          taskMode={taskMode}
          groupSize={studyInfo?.groupSize ?? null}
          durationMinutes={studyInfo?.durationMinutes ?? null}
        />
      )}
    </StudyShell>
  );
}
