import { useState } from "react";
import StudyShell from "./StudyShell";

/**
 * Page 6 — Debriefing & Compensation, the final page of the study.
 * Reveals the withheld study focus and gates the compensation link on the
 * "I have read the debriefing" checkbox. The link itself is set by the
 * researcher in the admin dashboard (Settings → Compensation Link), with
 * the build-time VITE_PAYMENT_URL as fallback.
 */
interface Props {
  /** Returned by the participant-completion endpoint after the exit survey. */
  completionUrl?: string;
}

export default function DebriefingPage({ completionUrl = "" }: Props) {
  const [read, setRead] = useState(false);
  const paymentUrl = completionUrl || import.meta.env.VITE_PAYMENT_URL || "#";

  const paymentConfigured = paymentUrl !== "" && paymentUrl !== "#";

  return (
    <StudyShell>
      <div className="study-card">
        <h1>Thank you for participating!</h1>

        <h2>What this study was about</h2>
        <p>
          On the welcome page, we told you this study investigates how groups
          make decisions in online chat. That is true, but we can now tell you
          the specific focus: we examined whether an AI assistant that
          encourages balanced participation affects group decision-making.
          Depending on your session, the study assistant may have sent messages
          nudging members who spoke very little or very much, either privately
          or visibly in the group chat, or it may have stayed passive. This
          detail was withheld beforehand because knowing it could have changed
          how you communicated.
        </p>

        <h2>Your data</h2>
        <p>
          Research exports use pseudonymous participant codes. If you now
          prefer to withdraw your data, contact the researcher through
          Prolific Messages within 14 days and quote your Prolific participant
          ID. The researcher will remove the linked record; this does not
          affect your compensation.
        </p>
        <p>
          Please keep the study purpose confidential until data collection is
          complete, as other participants have not yet taken part.
        </p>
        <p>
          For questions or interest in the results, contact the researcher
          through Prolific Messages.
        </p>

        <label className="consent-check">
          <input
            type="checkbox"
            checked={read}
            onChange={(e) => setRead(e.target.checked)}
          />
          <span>I have read the debriefing.</span>
        </label>

        <div className="card-actions">
          {read && paymentConfigured ? (
            <a className="btn btn-primary" href={paymentUrl}>
              Return to Prolific
            </a>
          ) : (
            <button type="button" className="btn btn-primary" disabled>
              Return to Prolific
            </button>
          )}
          {read && !paymentConfigured && (
            <p className="error" role="alert">
              The Prolific completion link has not been configured yet. Please
              keep this page open and contact the researcher.
            </p>
          )}
        </div>
      </div>
    </StudyShell>
  );
}
