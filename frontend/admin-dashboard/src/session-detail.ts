import {
  FALLBACK_IDENTITY,
  buildIdentities,
  formatMmSs,
  identityFor,
  isServiceUser,
} from "@gdm/shared";
import type {
  ContributionShare,
  InterventionAudience,
  InterventionLog,
  InterventionTarget,
  Session,
  WindowEvaluation,
  WindowOutcome,
} from "@gdm/shared";

/**
 * Pure view-model builders for the session inspector. Everything here is
 * derived from the admin `Session` payload alone so it can be unit-tested
 * without React and reused by the chart, the tiles and the tables.
 */

export interface ParticipantIdentity {
  /** Matrix user id; null until credentials are provisioned. */
  userId: string | null;
  /** Colour name participants saw in the chat (Red, Blue, …). */
  name: string;
  color: string;
}

/**
 * Colour identities in the same order and palette the chat assigned them.
 * Participants without a Matrix id yet are appended in grey.
 */
export function participantIdentities(session: Session): ParticipantIdentity[] {
  const provisioned = session.participants.flatMap((p) =>
    p.matrixUserId ? [p.matrixUserId] : [],
  );
  const seen = new Set<string>(provisioned);
  for (const window of session.windowEvaluations ?? []) {
    for (const share of window.contributionSplit) seen.add(share.userId);
  }
  for (const message of session.chat.messages) seen.add(message.senderId);
  const identities = buildIdentities([...seen]);
  const ordered = [...identities.keys()].map((userId) => ({
    userId,
    ...identityFor(identities, userId),
  }));
  const pending = session.participants
    .filter((p) => !p.matrixUserId)
    .map((p) => ({
      userId: null,
      name: p.name || p.trackingToken.slice(0, 8),
      color: FALLBACK_IDENTITY.color,
    }));
  return [...ordered, ...pending];
}

export interface TimelineWindow {
  index: number;
  start: number;
  end: number;
  outcome: WindowOutcome;
  interventionId: string | null;
  shares: Map<string, ContributionShare>;
  candidateTargets: InterventionTarget[];
}

export interface TimelineNudge {
  id: string;
  at: number;
  audience: InterventionAudience;
  targetIds: string[];
  targetNames: string[];
  message: string;
}

export interface SessionTimeline {
  start: number;
  end: number;
  /** True while the session has no completedAt (axis runs to the planned end). */
  live: boolean;
  warmUpEnd: number;
  wrapUpStart: number;
  windowMs: number;
  threshold: number;
  /** Evaluated windows that carry a contribution split, oldest → newest. */
  windows: TimelineWindow[];
  /** Windows where a nudge would have fired but was suppressed (counterfactuals). */
  suppressed: TimelineWindow[];
  nudges: TimelineNudge[];
  messageTicks: Array<{ at: number; userId: string }>;
}

/** Null before the chat starts: there is no time axis to draw yet. */
export function sessionTimeline(session: Session): SessionTimeline | null {
  if (!session.startedAt) return null;
  const start = Date.parse(session.startedAt);
  const config = session.condition.config;
  const plannedEnd = start + session.durationMinutes * 60_000;
  const evaluations = [...(session.windowEvaluations ?? [])].sort(
    (a, b) => a.windowIndex - b.windowIndex,
  );
  const lastWindowEnd = evaluations.reduce(
    (max, w) => Math.max(max, Date.parse(w.windowEnd)),
    0,
  );
  const end = session.completedAt
    ? Math.max(Date.parse(session.completedAt), lastWindowEnd)
    : Math.max(plannedEnd, lastWindowEnd);

  const windows = evaluations
    .filter((w) => w.contributionSplit.length > 0)
    .map(toTimelineWindow);
  const suppressed = evaluations
    .filter((w) => w.outcome === "baseline-suppressed")
    .map(toTimelineWindow);
  const latest = evaluations.at(-1);
  const windowMinutes =
    latest?.contributionWindowMinutes ?? config.contributionWindowMinutes;

  return {
    start,
    end,
    live: !session.completedAt,
    warmUpEnd: start + config.protectedStartMinutes * 60_000,
    wrapUpStart: plannedEnd - config.protectedEndMinutes * 60_000,
    windowMs: windowMinutes * 60_000,
    threshold: latest?.threshold ?? config.contributionThreshold,
    windows,
    suppressed,
    nudges: session.interventions.map(toTimelineNudge),
    messageTicks: session.chat.messages
      .filter((m) => !isServiceUser(m.senderId))
      .map((m) => ({ at: Date.parse(m.timestamp), userId: m.senderId })),
  };
}

function toTimelineWindow(w: WindowEvaluation): TimelineWindow {
  return {
    index: w.windowIndex,
    start: Date.parse(w.windowStart),
    end: Date.parse(w.windowEnd),
    outcome: w.outcome,
    interventionId: w.interventionId,
    shares: new Map(w.contributionSplit.map((s) => [s.userId, s])),
    candidateTargets: w.candidateTargets,
  };
}

function toTimelineNudge(log: InterventionLog): TimelineNudge {
  return {
    id: log.id,
    at: Date.parse(log.timestamp),
    audience: log.audience,
    targetIds: log.targets.map((t) => t.userId),
    targetNames: log.targets.map((t) => t.identityName),
    message: log.message,
  };
}

export interface ComparisonCell {
  share: number;
  messageCount: number;
}

export interface ComparisonRow {
  userId: string;
  name: string;
  /** "unaddressed": in the split, but neither the target nor a logged quiet member. */
  role: "target" | "quiet" | "unaddressed";
  before: ComparisonCell;
  after: ComparisonCell;
}

export interface NudgeComparison {
  nudge: TimelineNudge;
  /** Index of the window that triggered the nudge; null if it cannot be linked. */
  windowIndex: number | null;
  /**
   * "window": both sides are the bot's own contribution shares (triggering
   * window vs. the next evaluated one). "messages": no later window exists
   * (with the default timing the only window closes right before wrap-up), so
   * both sides are plain message shares — the triggering window's message
   * counts vs. every participant message from the nudge to `afterUntil`.
   */
  basis: "window" | "messages";
  /** End of the "after" span for the messages basis (chat end, or now while live). */
  afterUntil: number | null;
  /** True while the session is live, so a messages-basis "after" is still growing. */
  live: boolean;
  rows: ComparisonRow[];
  /** Participants with at least one message before / after the nudge. */
  activeBefore: number;
  activeAfter: number;
}

/**
 * Before/after view of every nudge. Preferably measured in the bot's own
 * contribution windows: the split that triggered the nudge versus the next
 * evaluated window. Without a later window it falls back to message shares
 * over the rest of the chat (see `NudgeComparison.basis`). The "before"
 * split is carried by the InterventionLog itself, so it never depends on the
 * window record being present.
 */
export function nudgeComparisons(session: Session, now = Date.now()): NudgeComparison[] {
  const evaluations = [...(session.windowEvaluations ?? [])].sort(
    (a, b) => a.windowIndex - b.windowIndex,
  );
  const live = !session.completedAt;
  const chatEnd = session.completedAt ? Date.parse(session.completedAt) : now;
  return session.interventions.map((log) => {
    const nudge = toTimelineNudge(log);
    const trigger = linkedWindow(log, evaluations);
    const next =
      trigger === undefined
        ? undefined
        : evaluations.find(
            (w) => w.windowIndex > trigger.windowIndex && w.contributionSplit.length > 0,
          );
    const before = next ? windowCells(log.contributionSplit) : messageShareCells(log.contributionSplit);
    const after = next
      ? windowCells(next.contributionSplit)
      : messageShareCells(messagesBetween(session, nudge.at, chatEnd));
    const row = (member: InterventionTarget, role: ComparisonRow["role"]): ComparisonRow => ({
      userId: member.userId,
      name: member.identityName,
      role,
      before: before.get(member.userId) ?? EMPTY_CELL,
      after: after.get(member.userId) ?? EMPTY_CELL,
    });
    // The log names at most one target and two quiet members, so in larger
    // groups the rest of the split would otherwise drop out of the table.
    const named = new Set([...log.targets, ...log.quietMembers].map((m) => m.userId));
    const unaddressed = log.contributionSplit
      .filter((s) => !named.has(s.userId))
      .sort((a, b) => b.share - a.share || a.identityName.localeCompare(b.identityName));
    return {
      nudge,
      windowIndex: trigger?.windowIndex ?? null,
      basis: next ? "window" : "messages",
      afterUntil: next ? null : chatEnd,
      live,
      rows: [
        ...log.targets.map((t) => row(t, "target")),
        ...unaddressed.map((s) => row(s, "unaddressed")),
        ...log.quietMembers.map((t) => row(t, "quiet")),
      ],
      activeBefore: activeCount(before),
      activeAfter: activeCount(after),
    };
  });
}

const EMPTY_CELL: ComparisonCell = { share: 0, messageCount: 0 };

function windowCells(split: ContributionShare[]): Map<string, ComparisonCell> {
  return new Map(
    split.map((s) => [s.userId, { share: s.share, messageCount: s.messageCount }]),
  );
}

/** Message counts per user → cells whose share is the plain message share. */
function messageShareCells(
  counts: Array<{ userId: string; messageCount: number }>,
): Map<string, ComparisonCell> {
  const total = counts.reduce((sum, c) => sum + c.messageCount, 0);
  return new Map(
    counts.map((c) => [
      c.userId,
      {
        share: total > 0 ? c.messageCount / total : 0,
        messageCount: c.messageCount,
      },
    ]),
  );
}

/** Participant messages in (from, to], counted per sender. */
function messagesBetween(
  session: Session,
  from: number,
  to: number,
): Array<{ userId: string; messageCount: number }> {
  const counts = new Map<string, number>();
  for (const m of session.chat.messages) {
    const at = Date.parse(m.timestamp);
    if (isServiceUser(m.senderId) || at <= from || at > to) continue;
    counts.set(m.senderId, (counts.get(m.senderId) ?? 0) + 1);
  }
  return [...counts].map(([userId, messageCount]) => ({ userId, messageCount }));
}

function linkedWindow(
  log: InterventionLog,
  evaluations: WindowEvaluation[],
): WindowEvaluation | undefined {
  const byId = evaluations.find((w) => w.interventionId === log.id);
  if (byId) return byId;
  // Fallback for records written before window evaluations existed: the
  // window whose boundary is nearest to the nudge, within one window length.
  const at = Date.parse(log.timestamp);
  const tolerance = log.contributionWindowMinutes * 60_000;
  let best: WindowEvaluation | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const w of evaluations) {
    const distance = Math.abs(Date.parse(w.windowEnd) - at);
    if (distance <= tolerance && distance < bestDistance) {
      best = w;
      bestDistance = distance;
    }
  }
  return best;
}

function activeCount(cells: Map<string, ComparisonCell>): number {
  return [...cells.values()].filter((c) => c.messageCount > 0).length;
}

export type ClassifierSummary =
  | { mode: "off" }
  | {
      mode: "active";
      classified: number;
      failed: number;
      participantMessages: number;
      meanMeaningfulness: number | null;
    };

/** What the LLM classifier did in this session, or that it was not used. */
export function classifierSummary(session: Session): ClassifierSummary {
  const mode =
    session.windowEvaluations?.find((w) => w.llmMode)?.llmMode ??
    session.interventions[0]?.llmMode ??
    session.condition.config.llmMode ??
    "off";
  if (mode === "off") return { mode: "off" };
  const classifications = session.contributionClassifications;
  const mean =
    classifications.length > 0
      ? classifications.reduce((sum, c) => sum + c.meaningfulnessScore, 0) /
        classifications.length
      : null;
  return {
    mode: "active",
    classified: classifications.length,
    failed: session.classificationFailures?.length ?? 0,
    participantMessages: session.chat.messages.filter(
      (m) => !isServiceUser(m.senderId),
    ).length,
    meanMeaningfulness: mean,
  };
}

export interface Engagement {
  messages: number;
  typingMs: number;
  tabHidden: number;
  rankingMoves: number;
}

export interface EngagementSummary {
  perUser: Map<string, Engagement>;
  totals: Engagement;
  botMessages: number;
}

/** Per-participant activity from the chat log and behavioural telemetry. */
export function engagementSummary(session: Session): EngagementSummary {
  const perUser = new Map<string, Engagement>();
  const bump = (userId: string, patch: Partial<Engagement>) => {
    const current = perUser.get(userId) ?? {
      messages: 0,
      typingMs: 0,
      tabHidden: 0,
      rankingMoves: 0,
    };
    perUser.set(userId, {
      messages: current.messages + (patch.messages ?? 0),
      typingMs: current.typingMs + (patch.typingMs ?? 0),
      tabHidden: current.tabHidden + (patch.tabHidden ?? 0),
      rankingMoves: current.rankingMoves + (patch.rankingMoves ?? 0),
    });
  };
  let botMessages = 0;
  for (const message of session.chat.messages) {
    if (isServiceUser(message.senderId)) botMessages += 1;
    else bump(message.senderId, { messages: 1 });
  }
  for (const event of session.behavioralEvents) {
    if (event.type === "typing-stop") bump(event.participantId, { typingMs: event.durationMs ?? 0 });
    else if (event.type === "tab-hidden") bump(event.participantId, { tabHidden: 1 });
    else if (event.type === "ranking-move") bump(event.participantId, { rankingMoves: 1 });
  }
  const totals: Engagement = { messages: 0, typingMs: 0, tabHidden: 0, rankingMoves: 0 };
  for (const entry of perUser.values()) {
    totals.messages += entry.messages;
    totals.typingMs += entry.typingMs;
    totals.tabHidden += entry.tabHidden;
    totals.rankingMoves += entry.rankingMoves;
  }
  return { perUser, totals, botMessages };
}

/**
 * Chart label positions: each label wants its line's end height `ys[i]`, but
 * labels must stay `gap` apart and within [min, max]. Labels keep their
 * vertical order; overlaps are pushed down, and a stack that runs past `max`
 * is pushed back up. Returns positions in the input order.
 */
export function spreadLabels(ys: number[], gap: number, min: number, max: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y || a.i - b.i);
  const placed = order.map((o) => Math.min(max, Math.max(min, o.y)));
  for (let k = 1; k < placed.length; k += 1) {
    placed[k] = Math.max(placed[k], placed[k - 1] + gap);
  }
  for (let k = placed.length - 1; k >= 0; k -= 1) {
    const ceiling = k === placed.length - 1 ? max : placed[k + 1] - gap;
    placed[k] = Math.min(placed[k], ceiling);
  }
  const out = [...ys];
  order.forEach((o, k) => {
    out[o.i] = placed[k];
  });
  return out;
}

/** Milliseconds → `m:ss`, rounded to the nearest second. */
export function formatClock(ms: number): string {
  return formatMmSs(Math.round(ms / 1000));
}

/** Share (0..1) → `62%`. */
export function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`;
}
