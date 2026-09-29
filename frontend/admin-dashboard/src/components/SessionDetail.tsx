import { useMemo, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { Session } from "@gdm/shared";
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
  spreadLabels,
  type ComparisonRow,
  type Engagement,
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
        <div className="table-wrap fit">
          <table className="participants" aria-label="Participants">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Messages</th>
                <th>Typing</th>
                <th>Tab switches</th>
                <th>Ranking moves</th>
              </tr>
            </thead>
            <tbody>
              {identities.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No participants yet.
                  </td>
                </tr>
              )}
              {identities.map((p) => {
                const e = p.userId ? engagement.perUser.get(p.userId) : undefined;
                return (
                  <tr key={p.userId ?? p.name}>
                    <td>
                      <span className="swatch dot" style={{ background: p.color }} aria-hidden />
                      <strong>{p.name}</strong>
                    </td>
                    {e ? (
                      <EngagementCells e={e} />
                    ) : (
                      <td colSpan={4} className="muted">
                        no activity yet
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {identities.length > 0 && (
              <tfoot>
                <tr>
                  <td>All</td>
                  <EngagementCells
                    e={engagement.totals}
                    botMessages={engagement.botMessages}
                  />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

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

function EngagementCells({ e, botMessages = 0 }: { e: Engagement; botMessages?: number }) {
  return (
    <>
      <td>
        {e.messages}
        {botMessages > 0 && <span className="muted"> + {botMessages} bot</span>}
      </td>
      <td>{formatClock(e.typingMs)}</td>
      <td>{e.tabHidden}</td>
      <td>{e.rankingMoves}</td>
    </>
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
const LABEL_GAP = 12;
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

  // A share describes a whole window, so each one is drawn as a flat step
  // across its span. A nudge fires at its window's end: the step left of a
  // nudge line is "before", the step right of it is "after".
  const series = rows
    .map((p) => ({
      ...p,
      steps: timeline.windows.flatMap((w) => {
        const s = w.shares.get(p.userId);
        return s ? [{ window: w, x0: x(w.start), x1: x(w.end), py: y(s.share) }] : [];
      }),
    }))
    .filter((s) => s.steps.length > 0);

  // Direct labels sit in the right gutter, clear of the wrap-up band and the
  // time axis; a dotted leader ties each one to where its line ends.
  const labelYs = spreadLabels(
    series.map((s) => s.steps.at(-1)!.py),
    LABEL_GAP,
    TOP + 4,
    TOP + PLOT_H,
  );
  const endLabels = series.map((s, i) => ({
    name: s.name,
    color: s.color,
    px: s.steps.at(-1)!.x1,
    py: s.steps.at(-1)!.py,
    ly: labelYs[i],
  }));
  const labelX = LEFT + plotW + 10;

  const nearestWindow = (px: number): number | null => {
    if (timeline.windows.length === 0) return null;
    const inside = timeline.windows.findIndex((w) => px >= x(w.start) && px <= x(w.end));
    if (inside !== -1) return inside;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    timeline.windows.forEach((w, i) => {
      const distance = Math.abs((x(w.start) + x(w.end)) / 2 - px);
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
  const activeCenter = activeWindow ? (x(activeWindow.start) + x(activeWindow.end)) / 2 : 0;
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

        {/* Band over the active window */}
        {activeWindow && (
          <rect
            x={x(activeWindow.start)}
            y={TOP}
            width={Math.max(0, x(activeWindow.end) - x(activeWindow.start))}
            height={PLOT_H}
            fill={INK}
            opacity={0.06}
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
            <path
              d={stepPath(s.steps)}
              fill="none"
              stroke={s.color}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-testid="share-series"
            />
            {/* Who the nudge at this window's end targeted */}
            {s.steps
              .filter((st) => nudgeAt(st.window)?.targetIds.includes(s.userId))
              .map((st) => (
                <circle
                  key={st.window.index}
                  cx={st.x1}
                  cy={st.py}
                  r={5}
                  fill={s.color}
                  stroke="#fff"
                  strokeWidth={2}
                  data-testid="target-marker"
                />
              ))}
          </g>
        ))}
        {endLabels.map((l) => (
          <g key={l.name} data-testid="end-label">
            <line
              x1={l.px + 3}
              y1={l.py}
              x2={labelX - 3}
              y2={l.ly}
              stroke={l.color}
              strokeWidth={1}
              strokeDasharray="2 2"
              opacity={0.7}
            />
            <text x={labelX} y={l.ly + 3.5} fontSize={10} fill="#45566e">
              {l.name}
            </text>
          </g>
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

      <ChartKey timeline={timeline} />

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
            left: `${(activeCenter / W) * 100}%`,
            transform: activeCenter > W * 0.7 ? "translateX(-100%)" : undefined,
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

/** Consecutive windows join with a vertical riser; a gap starts a new run. */
function stepPath(steps: Array<{ x0: number; x1: number; py: number }>): string {
  let d = "";
  let previous: { x1: number } | undefined;
  for (const st of steps) {
    d +=
      previous && Math.abs(previous.x1 - st.x0) < 0.5
        ? ` V${st.py} H${st.x1}`
        : `${d ? " " : ""}M${st.x0},${st.py} H${st.x1}`;
    previous = st;
  }
  return d;
}

/** Explains the chart's marks; lists only those this session actually shows. */
function ChartKey({ timeline }: { timeline: SessionTimeline }) {
  const hasAudience = (audience: string) => timeline.nudges.some((n) => n.audience === audience);
  const items: Array<{ key: string; mark: ReactNode; label: string }> = [];
  if (timeline.windows.length > 0) {
    items.push({
      key: "share",
      mark: <path d="M1,8 H9 V4 H21" fill="none" stroke={INK_MUTED} strokeWidth={2.5} />,
      label: "share of one bot window",
    });
  }
  if (hasAudience("public")) {
    items.push({
      key: "public",
      mark: <line x1={11} x2={11} y1={0} y2={12} stroke={INK} strokeWidth={1.5} />,
      label: "public nudge",
    });
  }
  if (hasAudience("private")) {
    items.push({
      key: "private",
      mark: <line x1={11} x2={11} y1={0} y2={12} stroke={INK} strokeWidth={1.5} strokeDasharray="3 3" />,
      label: "private nudge",
    });
  }
  if (timeline.nudges.length > 0) {
    items.push({
      key: "target",
      mark: <circle cx={11} cy={6} r={4.5} fill={INK_MUTED} />,
      label: "person the nudge targeted",
    });
  }
  if (timeline.suppressed.length > 0) {
    items.push({
      key: "suppressed",
      mark: <circle cx={11} cy={6} r={4} fill="#fff" stroke={INK_MUTED} strokeWidth={1.5} />,
      label: "would have nudged (baseline, not sent)",
    });
  }
  items.push({
    key: "ticks",
    mark: (
      <>
        <rect x={5} y={2} width={1.5} height={8} fill={INK_MUTED} />
        <rect x={10} y={2} width={1.5} height={8} fill={INK_MUTED} />
        <rect x={16} y={2} width={1.5} height={8} fill={INK_MUTED} />
      </>
    ),
    label: "one tick per message",
  });
  return (
    <ul className="chart-key" aria-label="Chart key">
      {items.map((item) => (
        <li key={item.key}>
          <svg width={22} height={12} viewBox="0 0 22 12" aria-hidden>
            {item.mark}
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
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
  const { nudge, rows, windowIndex, basis, afterUntil, live, activeBefore, activeAfter } = comparison;
  const colorOf = (userId: string) => identities.find((i) => i.userId === userId)?.color ?? "#868e96";
  const clock = (t: number) => (timeline ? formatClock(t - timeline.start) : new Date(t).toLocaleTimeString());
  const beforeLabel = windowIndex === null ? "window not linked" : `window ${windowIndex + 1}`;
  const afterLabel =
    basis === "window"
      ? `window ${windowIndex! + 2}`
      : `messages ${clock(nudge.at)}–${clock(afterUntil!)}${live ? " so far" : ""}`;
  return (
    <div className="nudge-block">
      <div className="nudge-head">
        <strong>#{index}</strong>
        <span>{clock(nudge.at)}</span>
        <span className={`status ${nudge.audience === "private" ? "waiting" : "running"}`}>{nudge.audience}</span>
        <span>target {nudge.targetNames.join(", ")}</span>
        <span className="muted">
          {beforeLabel} → {afterLabel}
        </span>
      </div>
      <p className="muted nudge-text">“{nudge.message}”</p>
      {basis === "messages" && (
        <p className="basis-note">
          No bot window was evaluated after this nudge
          {live ? " yet" : " (the chat ended first)"}, so both sides are plain message shares: before
          = the messages in {windowIndex === null ? "the triggering window" : beforeLabel}, after = every participant
          message from the nudge to {live ? "now" : "the end of the chat"}. The two spans differ in length, so compare
          shares, not counts.
        </p>
      )}
      <div className="table-wrap compact">
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Role</th>
              <th>{basis === "window" ? "Share" : "Message share"} before → after</th>
              <th>Messages before → after</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ComparisonRowView
                key={`${row.userId}-${row.role}`}
                row={row}
                color={colorOf(row.userId)}
                countDelta={basis === "window"}
              />
            ))}
          </tbody>
        </table>
      </div>
      <span className="muted">
        Active participants {activeBefore} → {activeAfter}
      </span>
    </div>
  );
}

const ROLE_LABEL: Record<ComparisonRow["role"], string> = {
  target: "target",
  quiet: "quiet member",
  unaddressed: "other",
};

function ComparisonRowView({
  row,
  color,
  countDelta,
}: {
  row: ComparisonRow;
  color: string;
  /** Count deltas only make sense when both spans are equally long windows. */
  countDelta: boolean;
}) {
  // "Good" follows the nudge's intent: the target should shrink, quiet members
  // grow. The nudge had no intent for unaddressed members, so they stay neutral.
  const direction = (delta: number) =>
    row.role === "unaddressed" || Math.round(delta * 100) === 0
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
      <td>{ROLE_LABEL[row.role]}</td>
      <td>
        {formatShare(row.before.share)} → {formatShare(row.after.share)}{" "}
        <span className={`delta ${direction(row.deltaShare)}`}>({formatSharePoints(row.deltaShare)})</span>
      </td>
      <td>
        {row.before.messageCount} → {row.after.messageCount}
        {countDelta && (
          <>
            {" "}
            <span className={`delta ${direction(row.deltaMessages / 100)}`}>
              ({formatCount(row.deltaMessages)})
            </span>
          </>
        )}
      </td>
    </tr>
  );
}
