import { useState } from "react";
import { httpSessionManager } from "../study/sessionClient";
import DebriefingDisclosure from "./DebriefingDisclosure";
import StudyShell from "./StudyShell";

/**
 * Page 6 — Debriefing & Compensation, the final page of the study.
 * Reveals the withheld study focus and shows the compensation link.
 * The link itself is set by the researcher in the admin dashboard
 * (Settings → Compensation Link), with the build-time VITE_PAYMENT_URL
 * as fallback.
 */
interface Props {
  /** Returned for Prolific participants after the exit survey. */
  completionUrl?: string;
  prolificParticipant: boolean;
  sessionId: string;
  participantId: string;
}

export default function DebriefingPage({
  completionUrl = "",
  prolificParticipant,
  sessionId,
  participantId,
}: Props) {
  const paymentUrl = completionUrl || import.meta.env.VITE_PAYMENT_URL || "#";
  const paymentConfigured = paymentUrl !== "" && paymentUrl !== "#";
  const [feedback, setFeedback] = useState("");
  const [debriefAcknowledged, setDebriefAcknowledged] = useState(false);
  const [directFinished, setDirectFinished] = useState(false);

  function handleReturn() {
    if (feedback.trim()) {
      // Fire-and-forget: persist the feedback but don't block the redirect.
      httpSessionManager
        .submitDebriefFeedback(sessionId, participantId, feedback.trim())
        .catch(() => {});
    }
  }

  return (
    <StudyShell>
      <div className="study-card">
        <h1>Debrief</h1>

        <p>This is the end of the study.</p>

        <DebriefingDisclosure />

        <p>
          We'd love to hear your thoughts on the experiment — please share any
          feedback in the box below.
        </p>

        <textarea
          className="feedback-box"
          rows={4}
          placeholder="Optional feedback…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />

        <p>
          If you have further questions about the study, you can contact the
          researchers{prolificParticipant ? " through Prolific" : ""}.
        </p>
        <p>Thank you again for contributing to this research.</p>

        <label className="consent-check">
          <input
            type="checkbox"
            checked={debriefAcknowledged}
            onChange={() => setDebriefAcknowledged((value) => !value)}
          />
          <span>I have read and understood the debriefing above.</span>
        </label>

        <div className="card-actions">
          {!prolificParticipant && directFinished ? (
            <p>Your participation is complete. You may close this tab.</p>
          ) : !prolificParticipant ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!debriefAcknowledged}
              onClick={() => {
                handleReturn();
                setDirectFinished(true);
              }}
            >
              Finish study
            </button>
          ) : paymentConfigured && debriefAcknowledged ? (
            <a
              className="btn btn-primary"
              href={paymentUrl}
              onClick={handleReturn}
            >
              Return to Prolific
            </a>
          ) : paymentConfigured ? (
            <button type="button" className="btn btn-primary" disabled>
              Return to Prolific
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-primary" disabled>
                Return to Prolific
              </button>
              <p className="error" role="alert">
                The Prolific completion link has not been configured yet. Please
                keep this page open and contact the researcher.
              </p>
            </>
          )}
          {!debriefAcknowledged && (
            <p className="action-hint">
              Please acknowledge the debriefing before{" "}
              {prolificParticipant ? "returning" : "finishing"}.
            </p>
          )}
        </div>
      </div>
    </StudyShell>
  );
}
