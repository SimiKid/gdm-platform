import { useState } from "react";
import { EXPEDITION_MARS, EXPEDITION_MARS_BRIEFING } from "@gdm/shared";
import type { Survey } from "@gdm/shared";

interface Props {
  /** Called with the assembled entry survey (incl. the individual ranking). */
  onComplete: (survey: Survey) => void;
}

type Step = "questions" | "briefing" | "consent";
const STEPS: Step[] = ["questions", "briefing", "consent"];

/**
 * In-app entry survey (wireframe: Survey).
 *
 * The briefing page shows the Expedition-Mars scenario and asks the
 * participant to rank the items on their own first (the individual ranking,
 * captured for research). No name is collected — participants are shown by
 * assigned colour in the chat. Question set is a placeholder.
 */
export default function Survey({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("questions");
  const [order, setOrder] = useState<string[]>(
    EXPEDITION_MARS.items.map((i) => i.id),
  );
  const [consent, setConsent] = useState(false);
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [experience, setExperience] = useState("");

  const labels = new Map(EXPEDITION_MARS.items.map((i) => [i.id, i.label]));
  const stepIndex = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)]);

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const nextOrder = order.slice();
    [nextOrder[index], nextOrder[j]] = [nextOrder[j], nextOrder[index]];
    setOrder(nextOrder);
  }

  function submit() {
    const survey: Survey = {
      answers: {
        individualRanking: order,
        consent,
        age: Number(age),
        gender,
        committeeExperience: experience,
      },
      submittedAt: new Date().toISOString(),
    };
    onComplete(survey);
  }

  return (
    <div className="login-container">
      <p className="login-hint">
        Step {stepIndex + 1} of {STEPS.length}
      </p>

      {step === "briefing" && (
        <>
          <h1>{EXPEDITION_MARS_BRIEFING.title}</h1>
          <div
            className="briefing-body"
            style={{ width: 320 }}
            // Trusted, server-authored briefing HTML.
            dangerouslySetInnerHTML={{ __html: EXPEDITION_MARS_BRIEFING.html }}
          />
          <p className="login-hint">Your ranking (most to least critical):</p>
          <ol className="ranking-list" style={{ width: 320 }}>
            {order.map((id, idx) => (
              <li key={id} className="ranking-item">
                <span className="rank-num">{idx + 1}</span>
                <span className="rank-label">{labels.get(id) ?? id}</span>
                <span className="rank-actions">
                  <button
                    type="button"
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    aria-label="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, 1)}
                    disabled={idx === order.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
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
          <button type="button" onClick={submit} disabled={!consent}>
            Finish
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
            onClick={next}
            disabled={!age || !gender || !experience}
          >
            Continue
          </button>
        </>
      )}
    </div>
  );
}
