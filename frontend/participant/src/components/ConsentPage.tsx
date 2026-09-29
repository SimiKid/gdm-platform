import { useState } from "react";
import { CONSENT_ITEMS } from "../study/consent";

interface Props {
  /** Participants per group; null (unknown) keeps the wording number-free. */
  groupSize?: number | null;
  /** Called once all consent boxes are ticked and "Continue" is pressed. */
  onBegin: () => void;
  onDecline?: () => void;
}

/** Page 1 — Study Introduction & Informed Consent (two internal steps). */
export default function ConsentPage({
  groupSize = null,
  onBegin,
  onDecline,
}: Props) {
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
          The main task is a timed group decision with{" "}
          {groupSize === null
            ? "fully anonymized participants"
            : `${groupSize} fully anonymized participants in total`}
          , who are randomly assigned to groups.
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
      <p>Please read the following carefully before participating.</p>

      <p>
        <strong>Voluntary participation.</strong> Taking part is entirely
        voluntary. You may withdraw at any time without giving a reason and
        without any negative consequences. If you withdraw during the session,
        your data will be deleted upon request — contact the researcher via
        Prolific Messages to do so.
      </p>

      <p>
        <strong>Anonymity and pseudonymization.</strong> All data is collected
        under pseudonymous identifiers. If recruited through Prolific, your
        Prolific study and submission IDs are stored solely to match your
        responses to your submission and process your compensation. These
        identifiers are never shared externally.
      </p>

      <p>
        <strong>Data use and third-party processing.</strong> Pseudonymous chat
        messages are recorded and used for research analysis. Depending on the
        study group you are randomly assigned to, you may experience an
        AI-assisted feature. In that case, excerpts of your pseudonymous chat
        messages may be processed by a third-party AI service (Anthropic) to
        generate AI-assisted responses. No Prolific identifiers are included
        during the task phase. Anthropic processes data in accordance with its{" "}
        <a
          href="https://www.anthropic.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Privacy Policy
        </a>
        .
      </p>

      <p>
        <strong>Storage and publication.</strong> All study data is stored on
        servers at the University of Zurich (Switzerland) and used for
        scientific purposes only. Chat messages are recorded and may be analyzed
        and quoted in research publications, always in anonymous form.
      </p>

      <p>
        <strong>Risks.</strong> There are no known risks beyond those of
        everyday computer use. The study task is designed to create no personal
        risks or consequences.
      </p>

      <p>
        <strong>Compensation</strong> is the amount listed in the Prolific study
        and is paid upon full completion. If you are unable to be matched with a
        group, you will receive a partial reimbursement, and your data will be
        deleted. If you withdraw before completing the study, compensation may
        not be issued. Please check Prolific for details.
      </p>

      <p>
        <strong>Questions?</strong> Contact the researcher via Prolific
        Messages.
      </p>

      <section className="consent-box" aria-labelledby="consent-heading">
        <h2 id="consent-heading">Declaration of Consent</h2>
        <p>To proceed, please confirm all of the following:</p>
        {CONSENT_ITEMS.map(({ key, text }, i) => (
          <label key={key} className="consent-check">
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
        {onDecline && (
          <button type="button" className="btn-link" onClick={onDecline}>
            I do not consent
          </button>
        )}
      </div>
    </div>
  );
}
