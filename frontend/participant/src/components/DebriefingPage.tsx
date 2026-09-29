import { useState } from "react";
import { httpSessionManager } from "../study/sessionClient";
import DebriefingDisclosure from "./DebriefingDisclosure";
import StudyShell from "./StudyShell";

/**
 * Debriefing — the final page after the exit survey. Reveals the withheld
 * study focus and collects optional feedback. Prolific participants get the
 * completion link, set by the researcher in the admin dashboard (Settings →
 * "Prolific completion and exit paths" → Full completion); direct
 * participants just finish.
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
  const paymentConfigured = completionUrl !== "";
  const [feedback, setFeedback] = useState("");
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
          <strong>
            We'd love to hear your thoughts on the experiment — please share any
            feedback in the box below.
          </strong>
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
        <p>
          <strong>Thank you again for contributing to this research!</strong>
        </p>

        <div className="card-actions">
          {!prolificParticipant && directFinished ? (
            <p>Your participation is complete. You may close this tab.</p>
          ) : !prolificParticipant ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                handleReturn();
                setDirectFinished(true);
              }}
            >
              Finish study
            </button>
          ) : paymentConfigured ? (
            <a
              className="btn btn-primary"
              href={completionUrl}
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
