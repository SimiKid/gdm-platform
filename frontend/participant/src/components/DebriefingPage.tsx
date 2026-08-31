import { useState } from "react";
import { httpSessionManager } from "../study/sessionClient";
import StudyShell from "./StudyShell";

/**
 * Page 6 — Debriefing & Compensation, the final page of the study.
 * Reveals the withheld study focus and shows the compensation link.
 * The link itself is set by the researcher in the admin dashboard
 * (Settings → Compensation Link), with the build-time VITE_PAYMENT_URL
 * as fallback.
 */
interface Props {
  /** Returned by the participant-completion endpoint after the exit survey. */
  completionUrl?: string;
  sessionId: string;
  participantId: string;
}

export default function DebriefingPage({
  completionUrl = "",
  sessionId,
  participantId,
}: Props) {
  const paymentUrl = completionUrl || import.meta.env.VITE_PAYMENT_URL || "#";
  const paymentConfigured = paymentUrl !== "" && paymentUrl !== "#";
  const [feedback, setFeedback] = useState("");

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

        <p>
          We would like to share more details about the study: You were
          randomly assigned to one of two conditions: the chatbot sent messages
          either privately (to you) or publicly (to the whole group). Both
          types of messages highlighted the most contributing group member when
          they were contributing significantly more than the rest of the group.
          This detail was withheld during the study so you could experience the
          group discussion naturally; withholding it was necessary to avoid
          influencing your behavior and was approved as part of the study's
          ethics review. Our main research goal is to understand how these
          nudges affect the group — its performance and perceptions — as well
          as your individual experience.
        </p>

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
          researchers through Prolific.
        </p>
        <p>Thank you again for contributing to this research.</p>

        <div className="card-actions">
          {paymentConfigured ? (
            <a
              className="btn btn-primary"
              href={paymentUrl}
              onClick={handleReturn}
            >
              Return to Prolific
            </a>
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
        </div>
      </div>
    </StudyShell>
  );
}
