import { useEffect, useState } from "react";

interface Props {
  /** Called with the tracking token once a valid individual link is detected. */
  onEnter: (trackingToken: string, conditionId?: string) => void;
  /** Fallback for developers testing without a real study link. */
  onDevLogin: () => void;
}

/**
 * Recruiting landing (wireframe: Recruiting → Link).
 *
 * Reads the per-participant tracking token from the individual URL (`?p=`),
 * strips it from the address bar so it doesn't leak in history/screenshots,
 * and starts the study flow. The token only *identifies* the participant to
 * the Session Manager — condition assignment happens later, in the Waiting
 * Room, once the survey (incl. the name) is done.
 */
export default function Recruiting({ onEnter, onDevLogin }: Props) {
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [conditionId, setConditionId] = useState<string | undefined>();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get("p");
    const condition = params.get("conditionId") ?? params.get("c") ?? undefined;
    if (p) {
      const url = new URL(window.location.href);
      url.searchParams.delete("p");
      url.searchParams.delete("c");
      if (condition) url.searchParams.set("conditionId", condition);
      window.history.replaceState({}, "", url.toString());
      setTrackingToken(p);
      setConditionId(condition);
    }
    setChecked(true);
  }, []);

  if (!checked) return null;

  if (!trackingToken) {
    return (
      <div className="login-container">
        <h1>GDM Study Platform</h1>
        <p className="error">No valid study link.</p>
        <p className="login-hint">
          Please use the personal link you received to join the study.
        </p>
        <button type="button" className="toggle" onClick={onDevLogin}>
          Developer login
        </button>
      </div>
    );
  }

  return (
    <div className="login-container">
      <h1>Welcome to the study</h1>
      <p className="login-hint">
        You're about to take part in a short group decision-making exercise.
        The next screens will brief you and ask for your consent.
      </p>
      <button type="button" onClick={() => onEnter(trackingToken, conditionId)}>
        Start
      </button>
    </div>
  );
}
