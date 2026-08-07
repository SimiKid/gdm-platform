import { useState } from "react";

interface Props {
  /** Called once all consent boxes are ticked and "Begin study" is pressed. */
  onBegin: () => void;
}

const CONSENT_ITEMS = [
  "I am at least 18 years old.",
  "I have read and understood the information above.",
  "I voluntarily consent to participate in this study and to the recording and analysis of my chat messages.",
];

/** Page 1 — Welcome & Informed Consent. */
export default function ConsentPage({ onBegin }: Props) {
  const [checked, setChecked] = useState<boolean[]>(
    CONSENT_ITEMS.map(() => false),
  );
  const allChecked = checked.every(Boolean);

  function toggle(i: number) {
    setChecked((cur) => cur.map((c, j) => (j === i ? !c : c)));
  }

  return (
    <div className="study-card">
      <h1>Welcome to the Group Decision-Making Study</h1>
      <p>
        Thank you for your interest in this research study conducted at the
        Department of Informatics, University of Zurich. Please read the
        following information carefully before deciding to participate.
      </p>

      <h2>Purpose</h2>
      <p>
        This study investigates how small groups solve problems and make
        decisions together in online chat environments.
      </p>

      <h2>Procedure &amp; Duration</h2>
      <p>The session typically takes approximately 25–35 minutes and consists of:</p>
      <ul>
        <li>A short questionnaire about you</li>
        <li>An individual decision task (max. 10 minutes)</li>
        <li>A timed group discussion and decision task in a chat room</li>
        <li>A short exit survey</li>
      </ul>
      <p>
        The group discussion happens live. Please keep this study tab open and
        stay available for the complete session, because leaving may disrupt
        the other participants. A short connection loss is not itself a reason
        to lose compensation; reopen the study from Prolific if needed.
      </p>

      <h2>Voluntary Participation &amp; Withdrawal</h2>
      <p>
        Participation is voluntary. You may withdraw at any time without giving
        a reason and without any disadvantage. If you withdraw during the
        session, your data will be deleted on request.
      </p>

      <h2>Data Collection &amp; Confidentiality</h2>
      <ul>
        <li>
          Research data are collected under pseudonymous participant codes
          rather than names.
        </li>
        <li>
          If you were recruited through Prolific, your pseudonymous Prolific
          participant, study, and submission IDs are stored so your responses
          can be matched to your submission and compensation.
        </li>
        <li>
          Chat messages written during the group phase are recorded and
          analyzed for scientific purposes.
        </li>
        <li>
          Study records are stored on University of Zurich servers. In study
          conditions that use semantic assistance, recent pseudonymous chat
          text is sent to Anthropic's API to classify participation and create
          assistant wording; Prolific identifiers are not included in those
          requests. Results may be published only in aggregate or anonymized
          form.
        </li>
      </ul>

      <h2>Risks &amp; Benefits</h2>
      <p>
        There are no known risks beyond those of everyday computer use. There
        is no direct benefit to you; your participation contributes to research
        on collaborative decision-making. Compensation is the amount shown in
        the Prolific study listing and is processed after completion.
      </p>

      <h2>Contact</h2>
      <p>
        For questions about the study, contact the researcher through Prolific
        Messages.
        <br />
        For questions about your rights as a participant, use the same channel
        and ask for the University of Zurich ethics contact responsible for
        this study.
      </p>

      <section className="consent-box" aria-labelledby="consent-heading">
        <h2 id="consent-heading">Declaration of Consent</h2>
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
        {!allChecked && (
          <p className="action-hint">
            Please tick all three boxes above to begin.
          </p>
        )}
      </div>
    </div>
  );
}
