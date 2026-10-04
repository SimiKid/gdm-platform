import type { ParticipationOutcomeResponse } from "@gdm/shared";
import DebriefingDisclosure from "./DebriefingDisclosure";
import StudyShell from "./StudyShell";

interface Props {
  termination: ParticipationOutcomeResponse;
  /** Direct (non-Prolific) participants have no submission to return to. */
  prolificParticipant: boolean;
}

export default function StudyExitPage({ termination, prolificParticipant }: Props) {
  const partial = termination.compensationKind === "partial";
  const showDebrief = !["declined_consent", "ineligible"].includes(
    termination.outcome,
  );
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
        {showDebrief && <DebriefingDisclosure />}
        {prolificParticipant && (
          <div className="card-actions">
            {termination.redirectUrl ? (
              <a className="btn btn-primary" href={termination.redirectUrl}>
                Return to Prolific
              </a>
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
          </div>
        )}
      </div>
    </StudyShell>
  );
}
