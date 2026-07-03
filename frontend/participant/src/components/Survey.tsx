import { useState } from "react";
import type { Survey } from "@gdm/shared";

interface Props {
  /** Called with the participant's name and the assembled entry survey. */
  onComplete: (name: string, survey: Survey) => void;
}

type Step = "briefing" | "consent" | "name" | "questions";
const STEPS: Step[] = ["briefing", "consent", "name", "questions"];

/**
 * In-app entry survey (wireframe: Survey — Briefing, Consent, Name, Question).
 *
 * A small step wizard. The name is returned separately (it becomes
 * Participant.name); everything else is packed into a {@link Survey}. The
 * question set is a placeholder pending the final study instrument.
 */
export default function Survey({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("briefing");
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [experience, setExperience] = useState("");

  const stepIndex = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);

  function submit() {
    const survey: Survey = {
      answers: {
        consent,
        age: Number(age),
        gender,
        committeeExperience: experience,
      },
      submittedAt: new Date().toISOString(),
    };
    onComplete(name.trim(), survey);
  }

  return (
    <div className="login-container">
      <p className="login-hint">
        Step {stepIndex + 1} of {STEPS.length}
      </p>

      {step === "briefing" && (
        <>
          <h1>Briefing</h1>
          <p className="login-hint">
            You'll join a small group to complete a decision-making exercise
            together via chat. There are no right or wrong answers — we're
            interested in how the group reaches a decision. The session takes a
            few minutes.
          </p>
          <button type="button" onClick={next}>
            Continue
          </button>
        </>
      )}

      {step === "consent" && (
        <>
          <h1>Consent</h1>
          <p className="login-hint">
            Your chat messages and choices are recorded for research and
            analysed in anonymised form. Participation is voluntary and you may
            stop at any time.
          </p>
          <label className="consent">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            I have read the information and consent to take part.
          </label>
          <button type="button" onClick={next} disabled={!consent}>
            Continue
          </button>
        </>
      )}

      {step === "name" && (
        <>
          <h1>Your name</h1>
          <p className="login-hint">
            This is shown to the other participants in the chat.
          </p>
          <input
            type="text"
            placeholder="Name or nickname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="button" onClick={next} disabled={!name.trim()}>
            Continue
          </button>
        </>
      )}

      {step === "questions" && (
        <>
          <h1>A few questions</h1>
          <input
            type="number"
            placeholder="Age"
            min={18}
            max={100}
            value={age}
            onChange={(e) => setAge(e.target.value)}
          />
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="">Gender…</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="diverse">Diverse</option>
            <option value="na">Prefer not to say</option>
          </select>
          <select
            value={experience}
            onChange={(e) => setExperience(e.target.value)}
          >
            <option value="">Experience on selection committees…</option>
            <option value="none">None</option>
            <option value="some">Some</option>
            <option value="extensive">Extensive</option>
          </select>
          <button
            type="button"
            onClick={submit}
            disabled={!age || !gender || !experience}
          >
            Finish
          </button>
        </>
      )}
    </div>
  );
}
