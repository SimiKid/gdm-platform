import { useEffect, useRef, useState } from "react";
import StudyShell from "./StudyShell";
import { TOKEN_STORAGE_KEY } from "../study/progress";

interface Props {
  /** Called with the tracking token once a valid individual link is detected. */
  onEnter: (trackingToken: string, conditionId?: string) => void;
  /** Fallback for developers testing without a real study link. */
  onDevLogin: () => void;
}

/**
 * Recruiting landing (wireframe: Recruiting → Link).
 *
 * Two kinds of study links work here:
 * - Individual link (`?p=<token>`): the pre-assigned tracking token is read
 *   and stripped from the address bar so it doesn't leak in history, and the
 *   participant goes straight to the consent page (page 1).
 * - Generic link (no `?p=`): the researcher shares one URL with everyone;
 *   the app self-issues a random tracking token, kept in sessionStorage so a
 *   refresh in the same tab doesn't mint a second identity. A short welcome
 *   screen with a Start button renders here (also the developer-login entry).
 *
 * The token only *identifies* the participant to the Session Manager —
 * condition assignment happens later, in the Waiting Room, once the survey
 * is done.
 */
export default function Recruiting({ onEnter, onDevLogin }: Props) {
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [conditionId, setConditionId] = useState<string | undefined>();
  const entered = useRef(false);

  useEffect(() => {
    if (entered.current) return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get("p");
    const condition = params.get("conditionId") ?? params.get("c") ?? undefined;
    if (p) {
      entered.current = true;
      const url = new URL(window.location.href);
      url.searchParams.delete("p");
      url.searchParams.delete("c");
      if (condition) url.searchParams.set("conditionId", condition);
      window.history.replaceState({}, "", url.toString());
      sessionStorage.setItem(TOKEN_STORAGE_KEY, p);
      // Individual link: no landing needed — straight to consent (page 1).
      onEnter(p, condition);
      return;
    }
    // Generic study link: self-issue a token (stable across tab refreshes).
    let token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) {
      token = crypto.randomUUID();
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    }
    setTrackingToken(token);
    setConditionId(condition);
  }, [onEnter]);

  if (!trackingToken) return null;

  return (
    <StudyShell>
      <div className="study-card narrow centered">
        <h1>Welcome to the study</h1>
        <p>
          You're about to take part in a short group decision-making exercise.
          The next screens will brief you and ask for your consent.
        </p>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onEnter(trackingToken, conditionId)}
          >
            Start
          </button>
          <button type="button" className="btn-link" onClick={onDevLogin}>
            Developer login
          </button>
        </div>
      </div>
    </StudyShell>
  );
}
