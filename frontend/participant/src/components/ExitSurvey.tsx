import { useState } from "react";
import type { MatrixClient } from "matrix-js-sdk";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type { Session, Survey } from "@gdm/shared";
import { httpSessionManager } from "../study/sessionClient";

interface Props {
  client: MatrixClient;
  session: Session;
  participantId: string;
  /** Called once the exit survey is submitted and the session is completed. */
  onDone: () => void;
}

/** The group's final shared ranking, read from the room (fallback: initial). */
function readGroupRanking(client: MatrixClient, session: Session): string[] {
  const room = session.roomId ? client.getRoom(session.roomId) : null;
  if (room) {
    const events = room.getLiveTimeline().getEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].getType() === MATRIX_EVENT_TYPES.ranking) {
        const content = events[i].getContent() as { order?: string[] };
        if (Array.isArray(content.order)) return content.order;
      }
    }
  }
  return session.ranking.order;
}

/**
 * In-app exit survey (wireframe: Exit Survey behind the individual URL).
 *
 * Shown when the discussion timer runs out. It seeds the ranking with the
 * group's final order from the chat and asks the participant whether they'd
 * change anything (their post-discussion individual ranking), then a few
 * questions. Submitting persists everything and completes the session.
 */
export default function ExitSurvey({
  client,
  session,
  participantId,
  onDone,
}: Props) {
  const [order, setOrder] = useState<string[]>(() =>
    readGroupRanking(client, session),
  );
  const [satisfaction, setSatisfaction] = useState("");
  const [fairness, setFairness] = useState("");
  const [feltHeard, setFeltHeard] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const labels = new Map(session.rankingTask.items.map((i) => [i.id, i.label]));

  function move(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    const next = order.slice();
    [next[index], next[j]] = [next[j], next[index]];
    setOrder(next);
  }

  async function submit() {
    setSubmitting(true);
    const survey: Survey = {
      answers: {
        finalRanking: order,
        satisfaction: Number(satisfaction),
        fairness,
        feltHeard,
      },
      submittedAt: new Date().toISOString(),
    };
    try {
      await httpSessionManager.submitSurvey({
        sessionId: session.id,
        participantId,
        kind: "exit",
        survey,
      });
      await httpSessionManager.completeSession(session.id);
    } catch {
      /* best-effort; still end the flow for the participant */
    }
    onDone();
  }

  const ready = satisfaction && fairness && feltHeard;

  return (
    <div className="login-container">
      <h1>The discussion has ended</h1>

      <p className="login-hint" style={{ width: 320 }}>
        This is the group's final ranking. Would you change anything? Adjust it
        to your own final view.
      </p>
      <ol className="ranking-list" style={{ width: 320 }}>
        {order.map((id, idx) => (
          <li key={id} className="ranking-item">
            <span className="rank-num">{idx + 1}</span>
            <span className="rank-label">{labels.get(id) ?? id}</span>
            <span className="rank-actions">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                aria-label="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === order.length - 1}
                aria-label="Move down"
              >
                ↓
              </button>
            </span>
          </li>
        ))}
      </ol>

      <label className="field">
        How satisfied are you with the group's ranking?
        <select
          value={satisfaction}
          onChange={(e) => setSatisfaction(e.target.value)}
        >
          <option value="">Choose…</option>
          <option value="1">1 — Not at all</option>
          <option value="2">2</option>
          <option value="3">3 — Neutral</option>
          <option value="4">4</option>
          <option value="5">5 — Very satisfied</option>
        </select>
      </label>

      <label className="field">
        The group reached its decision fairly.
        <select value={fairness} onChange={(e) => setFairness(e.target.value)}>
          <option value="">Choose…</option>
          <option value="agree">Agree</option>
          <option value="neutral">Neutral</option>
          <option value="disagree">Disagree</option>
        </select>
      </label>

      <label className="field">
        I felt my views were heard.
        <select value={feltHeard} onChange={(e) => setFeltHeard(e.target.value)}>
          <option value="">Choose…</option>
          <option value="yes">Yes</option>
          <option value="somewhat">Somewhat</option>
          <option value="no">No</option>
        </select>
      </label>

      <button type="button" onClick={submit} disabled={!ready || submitting}>
        {submitting ? "Submitting…" : "Finish"}
      </button>
    </div>
  );
}
