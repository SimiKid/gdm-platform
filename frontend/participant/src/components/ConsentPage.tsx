import { useState } from "react";

interface Props {
  /** Called once all consent boxes are ticked and "Continue" is pressed. */
  onBegin: () => void;
}

const CONSENT_ITEMS = [
  "I am at least 18 years old.",
  "I have read and understood the information above.",
  "I voluntarily consent to participate in this study.",
];

/** Page 1 — Study Introduction & Informed Consent (two internal steps). */
export default function ConsentPage({ onBegin }: Props) {
  const [showConsent, setShowConsent] = useState(false);
  const [introAcknowledged, setIntroAcknowledged] = useState(false);
  const [checked, setChecked] = useState<boolean[]>(
    CONSENT_ITEMS.map(() => false),
  );
  const allChecked = checked.every(Boolean);

  function toggle(i: number) {
    setChecked((cur) => cur.map((c, j) => (j === i ? !c : c)));
  }

  if (!showConsent) {
    return (
      <div className="study-card">
        <h1>Welcome to the Study</h1>
        <p>
          Thank you for your interest in this study conducted at the Department
          of Informatics, University of Zurich, which investigates chat-based
          group decision-making scenarios with a chatbot present during the
          discussion.
        </p>
        <p>
          <strong>
            The study will take approximately 25–35 minutes to complete.
          </strong>{" "}
          The main task is a timed group decision with five fully anonymized
          participants, who are randomly assigned to groups.
        </p>

        <h2>Please Note</h2>
        <ul>
          <li>
            The group discussion happens live. When entering, make sure you are
            available for the entire session. Do not close the browser tab of the
            study. In case of a short connection loss, reopen the study from
            Prolific.
          </li>
          <li>
            This study requires good proficiency in English. You will be asked to
            confirm your proficiency level later in the study; participants with
            limited English proficiency will not be able to continue.
          </li>
        </ul>

        <section className="consent-box" aria-labelledby="intro-ack-heading">
          <label className="consent-check">
            <input
              type="checkbox"
              checked={introAcknowledged}
              onChange={() => setIntroAcknowledged((v) => !v)}
            />
            <span>I have read and understand the terms above</span>
          </label>
        </section>

        {introAcknowledged && (
          <div className="card-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowConsent(true)}
            >
              Continue to the consent form
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="study-card">
      <h1>Consent Form</h1>
      <p>
        Please read the following information carefully in order to participate.
      </p>

      <p>
        <strong>Participation is voluntary.</strong> You may withdraw at any time
        without giving a reason and without any disadvantage. If you withdraw
        during the session, your data will be deleted on request.
      </p>

      <p>
        <strong>Participation is anonymous.</strong> All data is collected under
        pseudonymous identifiers. If you were recruited through Prolific, your
        study and submission IDs are stored so your responses can be matched to
        your submission and compensation.
      </p>

      <p>
        <strong>The collected data</strong> is stored on European servers and
        only used for scientific purposes. Chat messages written during the group
        phase are recorded and analyzed for research publications. As the study
        uses semantic assistance, recent pseudonymous chat text is sent to
        Anthropic's API to classify participation and create assistant wording.
        Prolific identifiers are not included in those requests. Results may be
        published only in an anonymous form.
      </p>

      <p>
        There are no known risks beyond those of everyday computer use. Your
        participation contributes to research on collaborative decision-making.
        Compensation is the amount shown in the Prolific study listing and is
        processed after completion.
      </p>

      <p>
        For questions about the study, contact the researcher through Prolific
        Messages.
      </p>

      <section className="consent-box" aria-labelledby="consent-heading">
        <h2 id="consent-heading">Declaration of Consent</h2>
        <p>
          To proceed with the study, all boxes of the declaration of consent must
          be ticked:
        </p>
        {CONSENT_ITEMS.map((text, i) => (
          <label key={text} className="consent-check">
            <input
              type="checkbox"
              checked={checked[i]}
              onChange={() => toggle(i)}
            />
            <span>{text}</span>
          </label>
        ))}
      </section>

      <div className="card-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!allChecked}
          onClick={onBegin}
        >
          Begin study
        </button>
      </div>
    </div>
  );
}
