import { useState } from "react";
import type { ParticipationOutcomeResponse } from "@gdm/shared";
import DebriefingDisclosure from "./DebriefingDisclosure";
import StudyShell from "./StudyShell";

export default function StudyExitPage({
  termination,
}: {
  termination: ParticipationOutcomeResponse;
}) {
  const [debriefAcknowledged, setDebriefAcknowledged] = useState(false);
  const partial = termination.compensationKind === "partial";
  const showDebrief = !["declined_consent", "ineligible"].includes(
    termination.outcome,
  );
  const mayReturn = !showDebrief || debriefAcknowledged;
  return (
    <StudyShell>
      <div className="study-card narrow">
        <h1>Your participation has ended</h1>
        <p>{termination.message}</p>
        {partial && termination.compensationAmountPence !== undefined && (
          <p>
            Partial payment recorded for review:{" "}
            <strong>
              £{(termination.compensationAmountPence / 100).toFixed(2)}
            </strong>
            . It is processed separately from the returned submission.
          </p>
        )}
        {termination.compensationKind === "manual_review" && (
          <p>
            The researcher will review the time you spent and contact you
            through Prolific.
          </p>
        )}
        {showDebrief && (
          <>
            <DebriefingDisclosure />
            <label className="consent-check">
              <input
                type="checkbox"
                checked={debriefAcknowledged}
                onChange={() => setDebriefAcknowledged((value) => !value)}
              />
              <span>I have read and understood the debriefing above.</span>
            </label>
          </>
        )}
        <div className="card-actions">
          {termination.redirectUrl && mayReturn ? (
            <a
              className="btn btn-primary"
              href={termination.redirectUrl}
            >
              Return to Prolific
            </a>
          ) : termination.redirectUrl ? (
            <button type="button" className="btn btn-primary" disabled>
              Return to Prolific
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-primary" disabled>
                Return to Prolific
              </button>
              <p className="error" role="alert">
                The return link is not configured. Please keep this page open
                and contact the researcher through Prolific.
              </p>
            </>
          )}
          {!mayReturn && (
            <p className="action-hint">Please acknowledge the debriefing before returning.</p>
          )}
        </div>
      </div>
    </StudyShell>
  );
}
