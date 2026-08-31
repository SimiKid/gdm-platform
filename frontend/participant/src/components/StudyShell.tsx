import type { ReactNode } from "react";

interface Props {
  /** Highlights the active step (1–4); omit to hide the progress indicator. */
  step?: 1 | 2 | 3 | 4;
  children: ReactNode;
  onWithdraw?: () => void;
}

const STEP_LABELS = ["Consent", "About you", "Individual task", "Group phase"];

/**
 * Shared page frame for the participant study flow: light background,
 * centered ~680px column, and the step 1–4 progress indicator on top.
 * Pages render their own `.study-card` sections inside.
 */
export default function StudyShell({ step, children, onWithdraw }: Props) {
  return (
    <div className="study-page">
      <div className="study-column">
        {step && (
          <nav className="progress-steps" aria-label={`Study progress: step ${step} of 4`}>
            {STEP_LABELS.map((label, i) => {
              const n = i + 1;
              const state = n < step ? "done" : n === step ? "current" : "todo";
              return (
                <div
                  key={label}
                  className={`progress-step ${state}`}
                  aria-current={n === step ? "step" : undefined}
                >
                  <span className="progress-dot" aria-hidden="true">
                    {n < step ? "✓" : n}
                  </span>
                  <span className="progress-label">{label}</span>
                </div>
              );
            })}
          </nav>
        )}
        {children}
        {onWithdraw && (
          <div className="withdraw-actions">
            <button type="button" className="btn-link" onClick={onWithdraw}>
              Withdraw from this study
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
