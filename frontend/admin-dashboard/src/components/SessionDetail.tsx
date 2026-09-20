import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Session } from "@gdm/shared";
import { STATUS_LABEL } from "../labels";
import {
  classifierSummary,
  engagementSummary,
  formatClock,
  formatCount,
  formatShare,
  formatSharePoints,
  nudgeComparisons,
  participantIdentities,
  sessionTimeline,
  type ComparisonRow,
  type NudgeComparison,
  type ParticipantIdentity,
  type SessionTimeline,
  type TimelineWindow,
} from "../session-detail";

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
  const nameOf = (userId: string) =>
    identities.find((i) => i.userId === userId)?.name ?? userId;

  const elapsedMs = session.startedAt
    ? Date.parse(session.completedAt ?? new Date().toISOString()) -
      Date.parse(session.startedAt)
    : null;
  const audiences = new Set(session.interventions.map((i) => i.audience));

  return (
    <div className="session-detail">
      <div className="session-head">
        <strong>{session.id.slice(0, 8)}</strong>
        <span className={`status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
        <span>Round {session.roundId}</span>
        <span>{session.condition.name}</span>
        <span>bot {session.condition.config.interventionMode}</span>
        <span>
          {session.startedAt
            ? `started ${new Date(session.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "not started"}
        </span>
        {elapsedMs !== null && (
          <span>
            {formatClock(elapsedMs)} of {session.durationMinutes} min
          </span>
        )}
        <span className="muted">{session.roomId ?? "room not provisioned"}</span>
      </div>

      <ul className="legend" aria-label="Participants">
        {identities.length === 0 && <li className="muted">No participants yet.</li>}
        {identities.map((p) => {
          const e = p.userId ? engagement.perUser.get(p.userId) : undefined;
          return (
            <li key={p.userId ?? p.name}>
              <span className="swatch dot" style={{ background: p.color }} aria-hidden />
              <strong>{p.name}</strong>
              <span className="muted">
                {e
                  ? `${plural(e.messages, "msg")} · typing ${formatClock(e.typingMs)} · ${plural(e.tabHidden, "tab switch", "tab switches")} · ${plural(e.rankingMoves, "ranking move")}`
                  : "no activity yet"}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="detail">
        <Fact
          label="Messages"
          value={String(engagement.totals.messages)}
          note={engagement.botMessages > 0 ? `+ ${plural(engagement.botMessages, "bot message")}` : undefined}
        />
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
        <Fact
          label="Behaviour"
          value={`typing ${formatClock(engagement.totals.typingMs)}`}
          note={`${plural(engagement.totals.tabHidden, "tab switch", "tab switches")} · ${plural(engagement.totals.rankingMoves, "ranking move")}`}
        />
      </div>

      <h3 className="subhead">Nudge response timeline</h3>
      {timeline ? (
        <NudgeTimeline timeline={timeline} identities={identities} nameOf={nameOf} />
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
        <details className="window-table">
          <summary>Window table</summary>
          <div className="table-wrap compact">
            <table>
              <thead>
                <tr>
                  <th>Window</th>
                  <th>Time</th>
                  <th>Outcome</th>
                  {identities.map((p) => (
                    <th key={p.userId ?? p.name}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeline.windows.map((w) => (
                  <tr key={w.index}>
                    <td>{w.index + 1}</td>
                    <td>
                      {formatClock(w.start - timeline.start)}–{formatClock(w.end - timeline.start)}
                    </td>
                    <td>{w.outcome}</td>
                    {identities.map((p) => {
                      const s = p.userId ? w.shares.get(p.userId) : undefined;
                      return (
                        <td key={p.userId ?? p.name}>
                          {s ? `${formatShare(s.share)} · ${s.messageCount} msgs` : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ── Chart ───────────────────────────────────────────────────────────────

const W = 720;
const LEFT = 44;
const RIGHT = 64;
const TOP = 24;
const PLOT_H = 140;
const AXIS_H = 22;
const TICK_ROW = 10;
const INK = "#172033";
const INK_MUTED = "#65758c";
const GRID = "#e8edf4";
const PHASE = "#f1f4f8";

function NudgeTimeline({
  timeline,
  identities,
  nameOf,
}: {
  timeline: SessionTimeline;
  identities: ParticipantIdentity[];
  nameOf: (userId: string) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const rows = identities.filter((p): p is ParticipantIdentity & { userId: string } => p.userId !== null);
  const plotW = W - LEFT - RIGHT;
  const stripTop = TOP + PLOT_H + AXIS_H;
  const height = stripTop + Math.max(rows.length, 1) * TICK_ROW + 6;
  const span = Math.max(1, timeline.end - timeline.start);
  const x = (t: number) => LEFT + ((t - timeline.start) / span) * plotW;
  const y = (share: number) => TOP + (1 - Math.min(1, Math.max(0, share))) * PLOT_H;

  // Expected window boundaries (from the condition) give an axis even before
  // the first evaluation lands; evaluated windows snap to the same grid.
  const boundaries: number[] = [];
  for (let t = timeline.warmUpEnd; t <= timeline.end + 1; t += timeline.windowMs) boundaries.push(t);
  const labelEvery = boundaries.length > 10 ? 2 : 1;

  const series = rows
    .map((p) => ({
      ...p,
      points: timeline.windows.flatMap((w) => {
        const s = w.shares.get(p.userId);
        return s ? [{ window: w, px: x(w.end), py: y(s.share), share: s }] : [];
      }),
    }))
    .filter((s) => s.points.length > 0);

  // Direct end labels, pushed apart when lines converge at the right edge.
  const endLabels = series
    .map((s) => ({ name: s.name, px: s.points.at(-1)!.px, py: s.points.at(-1)!.py }))
    .sort((a, b) => a.py - b.py);
  for (let i = 1; i < endLabels.length; i += 1) {
    if (endLabels[i].py - endLabels[i - 1].py < 12) endLabels[i].py = endLabels[i - 1].py + 12;
  }

  const nearestWindow = (px: number): number | null => {
    if (timeline.windows.length === 0) return null;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    timeline.windows.forEach((w, i) => {
      const distance = Math.abs(x(w.end) - px);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  };

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || W;
    setActive(nearestWindow(((event.clientX - rect.left) / width) * W));
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const n = timeline.windows.length;
    if (n === 0) return;
    if (event.key === "ArrowRight") setActive((a) => (a === null ? 0 : Math.min(a + 1, n - 1)));
    else if (event.key === "ArrowLeft") setActive((a) => (a === null ? n - 1 : Math.max(a - 1, 0)));
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  }

  const activeWindow = active === null ? null : timeline.windows[active];
  const nudgeAt = (w: TimelineWindow) => timeline.nudges.find((n) => n.id === w.interventionId);

  return (
    <div className="timeline">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={`Contribution share per participant over ${formatClock(span)} of chat, with ${timeline.nudges.length} nudge markers. Use arrow keys to step through windows.`}
        tabIndex={0}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        {/* Protected phases */}
        <rect x={LEFT} y={TOP} width={Math.max(0, x(timeline.warmUpEnd) - LEFT)} height={PLOT_H} fill={PHASE} />
        <rect
          x={x(timeline.wrapUpStart)}
          y={TOP}
          width={Math.max(0, LEFT + plotW - x(timeline.wrapUpStart))}
          height={PLOT_H}
          fill={PHASE}
        />
        <text x={LEFT + 4} y={TOP + 12} fontSize={10} fill={INK_MUTED}>
          warm-up
        </text>
        <text x={LEFT + plotW - 4} y={TOP + 12} fontSize={10} fill={INK_MUTED} textAnchor="end">
          wrap-up
        </text>

        {/* Gridlines and share axis */}
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={LEFT + plotW} y1={y(v)} y2={y(v)} stroke={GRID} strokeWidth={1} />
            <text x={LEFT - 6} y={y(v) + 3} fontSize={10} fill={INK_MUTED} textAnchor="end">
              {formatShare(v)}
            </text>
          </g>
        ))}
        <line
          x1={LEFT}
          x2={LEFT + plotW}
          y1={y(timeline.threshold)}
          y2={y(timeline.threshold)}
          stroke={INK_MUTED}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text x={LEFT + 4} y={y(timeline.threshold) - 4} fontSize={10} fill={INK_MUTED}>
          threshold {formatShare(timeline.threshold)}
        </text>

        {/* Time axis: one tick per contribution window */}
        <line x1={LEFT} x2={LEFT + plotW} y1={TOP + PLOT_H} y2={TOP + PLOT_H} stroke={GRID} />
        {boundaries.map((t, i) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={TOP + PLOT_H} y2={TOP + PLOT_H + 4} stroke={INK_MUTED} />
            {i % labelEvery === 0 && (
              <text x={x(t)} y={TOP + PLOT_H + 15} fontSize={10} fill={INK_MUTED} textAnchor="middle">
                {formatClock(t - timeline.start)}
              </text>
            )}
          </g>
        ))}

        {/* Crosshair for the active window */}
        {activeWindow && (
          <line
            x1={x(activeWindow.end)}
            x2={x(activeWindow.end)}
            y1={TOP}
            y2={TOP + PLOT_H}
            stroke={INK}
            strokeWidth={1}
            opacity={0.35}
            data-testid="crosshair"
          />
        )}

        {/* Suppressed (counterfactual) windows */}
        {timeline.suppressed.map((w) => (
          <circle
            key={`s${w.index}`}
            cx={x(w.end)}
            cy={TOP - 8}
            r={4}
            fill="#fff"
            stroke={INK_MUTED}
            strokeWidth={1.5}
            data-testid="suppressed-marker"
          >
            <title>
              {`Would have targeted ${w.candidateTargets.map((t) => t.identityName).join(", ")} (${w.outcome})`}
            </title>
          </circle>
        ))}

        {/* Nudges */}
        {timeline.nudges.map((n, i) => (
          <g key={n.id} data-testid="nudge-marker">
            <line
              x1={x(n.at)}
              x2={x(n.at)}
              y1={TOP - 4}
              y2={TOP + PLOT_H}
              stroke={INK}
              strokeWidth={1.5}
              strokeDasharray={n.audience === "private" ? "3 3" : undefined}
            />
            <text x={x(n.at)} y={TOP - 10} fontSize={10} fill={INK} textAnchor="middle" fontWeight={650}>
              #{i + 1}
            </text>
            <title>{`Nudge #${i + 1} (${n.audience}) → ${n.targetNames.join(", ")} at ${formatClock(n.at - timeline.start)}`}</title>
          </g>
        ))}

        {/* Series */}
        {series.map((s) => (
          <g key={s.userId}>
            <polyline
              points={s.points.map((p) => `${p.px},${p.py}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {s.points.map((p) => {
              const targeted = nudgeAt(p.window)?.targetIds.includes(s.userId) ?? false;
              return (
                <circle
                  key={p.window.index}
                  cx={p.px}
                  cy={p.py}
                  r={targeted ? 6 : 4}
                  fill={s.color}
                  stroke="#fff"
                  strokeWidth={2}
                />
              );
            })}
          </g>
        ))}
        {endLabels.map((l) => (
          <text
            key={l.name}
            x={l.px + 9}
            y={l.py + 4}
            fontSize={11}
            fill="#45566e"
            stroke="#fff"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {l.name}
          </text>
        ))}

        {/* Message ticks, one row per participant */}
        {rows.map((p, i) => (
          <g key={p.userId}>
            <text x={LEFT - 6} y={stripTop + i * TICK_ROW + 7} fontSize={9} fill={INK_MUTED} textAnchor="end">
              {p.name}
            </text>
            {timeline.messageTicks
              .filter((t) => t.userId === p.userId)
              .map((t, j) => (
                <rect
                  key={j}
                  x={x(t.at) - 0.75}
                  y={stripTop + i * TICK_ROW}
                  width={1.5}
                  height={7}
                  fill={p.color}
                />
              ))}
          </g>
        ))}
      </svg>

      {timeline.windows.length === 0 && (
        <p className="muted">
          {timeline.live
            ? `No contribution window evaluated yet; the first one closes at ${formatClock(timeline.warmUpEnd + timeline.windowMs - timeline.start)}.`
            : "No contribution window was evaluated in this session."}
        </p>
      )}

      {activeWindow && (
        <div
          className="timeline-tip"
          role="status"
          style={{
            left: `${(x(activeWindow.end) / W) * 100}%`,
            transform: x(activeWindow.end) > W * 0.7 ? "translateX(-100%)" : undefined,
          }}
        >
          <div>
            Window {activeWindow.index + 1} · {formatClock(activeWindow.start - timeline.start)}–
            {formatClock(activeWindow.end - timeline.start)} · {activeWindow.outcome}
          </div>
          {rows.map((p) => {
            const s = activeWindow.shares.get(p.userId);
            return (
              <div className="row" key={p.userId}>
                <span className="swatch" style={{ background: p.color }} aria-hidden />
                <strong>{s ? formatShare(s.share) : "—"}</strong>
                <span>
                  {p.name}
                  {s ? ` · ${plural(s.messageCount, "msg")}` : ""}
                </span>
              </div>
            );
          })}
          {nudgeAt(activeWindow) && (
            <div className="row">nudged {nudgeAt(activeWindow)!.targetNames.map(nameOf).join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Before / after table ────────────────────────────────────────────────

function NudgeBlock({
  index,
  comparison,
  timeline,
  identities,
}: {
  index: number;
  comparison: NudgeComparison;
  timeline: SessionTimeline | null;
  identities: ParticipantIdentity[];
}) {
  const { nudge, rows, windowIndex, activeBefore, activeAfter } = comparison;
  const colorOf = (userId: string) => identities.find((i) => i.userId === userId)?.color ?? "#868e96";
  const at = timeline ? formatClock(nudge.at - timeline.start) : new Date(nudge.at).toLocaleTimeString();
  return (
    <div className="nudge-block">
      <div className="nudge-head">
        <strong>#{index}</strong>
        <span>{at}</span>
        <span className={`status ${nudge.audience === "private" ? "waiting" : "running"}`}>{nudge.audience}</span>
        <span>target {nudge.targetNames.join(", ")}</span>
        <span className="muted">
          {windowIndex === null
            ? "window not linked"
            : `window ${windowIndex + 1} → ${activeAfter === null ? "no later window yet" : windowIndex + 2}`}
        </span>
      </div>
      <p className="muted nudge-text">“{nudge.message}”</p>
      <div className="table-wrap compact">
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Role</th>
              <th>Share before → after</th>
              <th>Messages before → after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ComparisonRowView key={`${row.userId}-${row.role}`} row={row} color={colorOf(row.userId)} />
            ))}
          </tbody>
        </table>
      </div>
      <span className="muted">
        Active participants {activeBefore} → {activeAfter ?? "no later window yet"}
      </span>
    </div>
  );
}

function ComparisonRowView({ row, color }: { row: ComparisonRow; color: string }) {
  // "Good" follows the nudge's intent: the target should shrink, quiet members grow.
  const direction = (delta: number | null) =>
    delta === null || Math.round(delta * 100) === 0
      ? ""
      : (row.role === "target" ? delta < 0 : delta > 0)
        ? "good"
        : "bad";
  return (
    <tr>
      <td>
        <span className="swatch dot" style={{ background: color, marginRight: 6 }} aria-hidden />
        {row.name}
      </td>
      <td>{row.role === "target" ? "target" : "quiet member"}</td>
      <td>
        {formatShare(row.before.share)} → {row.after ? formatShare(row.after.share) : "—"}
        {row.deltaShare !== null && (
          <>
            {" "}
            <span className={`delta ${direction(row.deltaShare)}`}>({formatSharePoints(row.deltaShare)})</span>
          </>
        )}
      </td>
      <td>
        {row.before.messageCount} → {row.after ? row.after.messageCount : "—"}
        {row.deltaMessages !== null && (
          <>
            {" "}
            <span className={`delta ${direction(row.deltaMessages === 0 ? null : row.deltaMessages / 100)}`}>
              ({formatCount(row.deltaMessages)})
            </span>
          </>
        )}
      </td>
    </tr>
  );
}
