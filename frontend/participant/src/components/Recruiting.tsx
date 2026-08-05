import { useEffect, useRef, useState } from "react";
import type { ProlificIdentity } from "@gdm/shared";
import StudyShell from "./StudyShell";
import { TOKEN_STORAGE_KEY } from "../study/progress";
import {
  loadProlificIdentity,
  parseProlificIdentity,
  prolificTrackingToken,
  storeProlificIdentity,
  stripProlificParameters,
} from "../study/prolific";

interface Props {
  /** Called with the tracking token once a valid individual link is detected. */
  onEnter: (
    trackingToken: string,
    conditionId?: string,
    prolific?: ProlificIdentity,
  ) => void;
}

/**
 * Recruiting landing (wireframe: Recruiting → Link).
 *
 * Two kinds of study links work here:
 * - Prolific link (`PROLIFIC_PID`, `STUDY_ID`, `SESSION_ID`): all identifiers
 *   are captured, stripped from the address bar, and passed to the backend.
 * - Individual link (`?p=<token>`): the pre-assigned tracking token is read
 *   and stripped from the address bar so it doesn't leak in history, and the
 *   participant goes straight to the consent page (page 1).
 * - Generic link (no `?p=`): the researcher shares one URL with everyone;
 *   the app self-issues a random tracking token, kept in sessionStorage so a
 *   refresh in the same tab doesn't mint a second identity. A short welcome
 *   screen with a Start button renders here.
 *
 * The token only *identifies* the participant to the Session Manager —
 * condition assignment happens later, in the Waiting Room, once the survey
 * is done.
 */
export default function Recruiting({ onEnter }: Props) {
  const [trackingToken, setTrackingToken] = useState<string | null>(null);
  const [conditionId, setConditionId] = useState<string | undefined>();
  const [prolific, setProlific] = useState<ProlificIdentity | undefined>();
  const [linkError, setLinkError] = useState("");
  const entered = useRef(false);

  useEffect(() => {
    if (entered.current) return;
    const params = new URLSearchParams(window.location.search);
    const parsedProlific = parseProlificIdentity(params);
    const p = params.get("p");
    const condition = params.get("conditionId") ?? params.get("c") ?? undefined;

    if (parsedProlific.incomplete) {
      setLinkError(
        "This Prolific study link is incomplete. Please return to Prolific and open the study again.",
      );
      return;
    }

    if (parsedProlific.identity) {
      entered.current = true;
      const identity = parsedProlific.identity;
      const token = prolificTrackingToken(identity);
      const url = new URL(window.location.href);
      stripProlificParameters(url);
      url.searchParams.delete("p");
      url.searchParams.delete("c");
      if (condition) url.searchParams.set("conditionId", condition);
      window.history.replaceState({}, "", url.toString());
      sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
      storeProlificIdentity(identity);
      onEnter(token, condition, identity);
      return;
    }

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
    setProlific(loadProlificIdentity());
  }, [onEnter]);

  if (linkError) {
    return (
      <StudyShell>
        <div className="study-card narrow centered">
          <h1>Invalid study link</h1>
          <p className="error" role="alert">{linkError}</p>
        </div>
      </StudyShell>
    );
  }

  if (!trackingToken) return null;

  return (
    <StudyShell>
      <div className="study-card narrow centered">
        <h1>Welcome to the study</h1>
        <p>
          You're about to take part in a short group decision-making exercise.
          The next screens will brief you and ask for your consent.
        </p>
        <p>
          This is a live group study. Please keep this tab open throughout the
          session so the other participants are not left waiting.
        </p>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onEnter(trackingToken, conditionId, prolific)}
          >
            Start
          </button>
        </div>
      </div>
    </StudyShell>
  );
}
