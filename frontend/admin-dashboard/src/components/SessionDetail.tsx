import { useMemo } from "react";
import type { Session } from "@gdm/shared";
import {
  classifierSummary,
  engagementSummary,
  formatClock,
  nudgeComparisons,
  participantIdentities,
  sessionTimeline,
} from "../session-detail";
import NudgeBlock from "./session-detail/NudgeBlock";
import NudgeTimeline from "./session-detail/NudgeTimeline";
import ParticipantsTable from "./session-detail/ParticipantsTable";
import WindowTable from "./session-detail/WindowTable";

/**
 * Session inspector: what happened in one session, who dominated, when the
 * bot stepped in, and how the group reacted. Everything is derived from the
 * admin session payload; the chart is plain SVG (no charting dependency).
 */
export default function SessionDetail({ session }: { session: Session }) {
  const identities = useMemo(() => participantIdentities(session), [session]);
  const timeline = useMemo(() => sessionTimeline(session), [session]);
  const comparisons = useMemo(() => nudgeComparisons(session), [session]);
  const classifier = useMemo(() => classifierSummary(session), [session]);
  const engagement = useMemo(() => engagementSummary(session), [session]);
  const baseline = session.condition.config.interventionMode === "baseline";

  const elapsedMs = session.startedAt
    ? Date.parse(session.completedAt ?? new Date().toISOString()) -
      Date.parse(session.startedAt)
    : null;
  const audiences = new Set(session.interventions.map((i) => i.audience));

  // Status, round, condition and start time are already in the session row
  // this inspector unfolds under, so the head only adds what the row lacks.
  return (
    <div className="session-detail">
      <div className="session-head">
        <span>bot {session.condition.config.interventionMode}</span>
        {elapsedMs !== null && (
          <span>
            {formatClock(elapsedMs)} of {session.durationMinutes} min
          </span>
        )}
        <span className="muted">{session.roomId ?? "room not provisioned"}</span>
      </div>

      <div className="session-summary">
        <ParticipantsTable identities={identities} engagement={engagement} />

        <div className="detail facts">
          <Fact
            label="Nudges"
            value={String(session.interventions.length)}
            note={
              baseline
                ? "baseline arm never delivers"
                : audiences.size > 0
                  ? [...audiences].join(" · ")
                  : undefined
            }
          />
          <Fact
            label="Classifier"
            value={
              classifier.mode === "off"
                ? "not used"
                : `${classifier.classified} of ${classifier.participantMessages} messages classified`
            }
            note={
              classifier.mode === "active"
                ? [
                    classifier.meanMeaningfulness !== null
                      ? `mean meaningfulness ${classifier.meanMeaningfulness.toFixed(2)}`
                      : null,
                    classifier.failed > 0 ? `${classifier.failed} failed` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || undefined
                : undefined
            }
          />
          <Fact label="Ranking edits" value={String(session.rankingHistory?.length ?? 0)} />
        </div>
      </div>

      <h3 className="subhead">Nudge response timeline</h3>
      {timeline ? (
        <NudgeTimeline timeline={timeline} identities={identities} />
      ) : (
        <p className="empty">Timeline appears once the chat starts.</p>
      )}

      <h3 className="subhead">Before and after each nudge</h3>
      {comparisons.length === 0 && (
        <p className="muted">
          {baseline ? "No nudges delivered (baseline arm)." : "No nudge fired in this session."}
        </p>
      )}
      {comparisons.map((c, i) => (
        <NudgeBlock key={c.nudge.id} index={i + 1} comparison={c} timeline={timeline} identities={identities} />
      ))}
      {timeline && timeline.suppressed.length > 0 && (
        <p className="muted">
          {timeline.suppressed
            .map(
              (w) =>
                `Would have targeted ${w.candidateTargets.map((t) => t.identityName).join(", ") || "nobody"} at ${formatClock(w.end - timeline.start)} (${w.outcome})`,
            )
            .join(" · ")}
        </p>
      )}

      {timeline && timeline.windows.length > 0 && (
        <WindowTable timeline={timeline} identities={identities} />
      )}
    </div>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <span className="label">{label}</span>
      <strong>{value}</strong>
      {note && <span className="muted">{note}</span>}
    </div>
  );
}
