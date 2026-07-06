import { useEffect, useState } from "react";

interface Props {
  /** Called with the tracking token once a valid individual link is detected. */
  onEnter: (trackingToken: string, conditionId?: string) => void;
  /** Fallback for developers testing without a real study link. */
  onDevLogin: () => void;
}

/** Per-tab storage key for a self-issued tracking token (generic link). */
const TOKEN_STORAGE_KEY = "gdm-tracking-token";

/**
 * Recruiting landing (wireframe: Recruiting → Link).
 *
 * Two kinds of study links work here:
 * - Individual link (`?p=<token>`): the pre-assigned tracking token is read
 *   and stripped from the address bar so it doesn't leak in history.
 * - Generic link (no `?p=`): the researcher shares one URL with everyone;
 *   the app self-issues a random tracking token, kept in sessionStorage so a
 *   refresh in the same tab doesn't mint a second identity.
 *
 * The token only *identifies* the participant to the Session Manager —
 * condition assignment happens later, in the Waiting Room, once the survey
 * (incl. the name) is done.
 */
export default function Recruiting({ onEnter, onDevLogin }: Props) {
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [conditionId, setConditionId] = useState<string | undefined>();

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
      sessionStorage.setItem(TOKEN_STORAGE_KEY, p);
      setTrackingToken(p);
    } else {
      // Generic study link: self-issue a token (stable across tab refreshes).
      let token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        token = crypto.randomUUID();
        sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      }
      setTrackingToken(token);
    }
    setConditionId(condition);
  }, []);

  if (!trackingToken) return null;

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
      <button type="button" className="toggle" onClick={onDevLogin}>
        Developer login
      </button>
    </div>
  );
}
