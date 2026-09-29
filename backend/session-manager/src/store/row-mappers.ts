import type { Prisma } from "@prisma/client";
import type {
  BehavioralEvent,
  BotConfig,
  Briefing,
  ClassificationFailure,
  Condition,
  ContributionClassification,
  InterventionLog,
  Message,
  Participant,
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationStage,
  Poll,
  ProlificArrival,
  Ranking,
  RankingTask,
  Session,
  SessionSummary,
  Survey,
  WindowEvaluation,
} from "@gdm/shared";
import { normalizeCondition } from "./conditions";
import { fromJson, json, toDate, toOptionalDate } from "./prisma-values";
import { dedupeWindowEvaluations } from "./window-evaluations";

/**
 * Pure mapping between Prisma rows and the shared domain DTOs. No queries
 * run here; the store decides what to load and write.
 */

export const SESSION_INCLUDE = {
  participants: {
    include: { surveys: true },
    orderBy: { createdAt: "asc" },
  },
  messages: {
    include: { reactions: true },
    orderBy: { timestamp: "asc" },
  },
  rankingHistory: {
    orderBy: { position: "asc" },
  },
  interventions: {
    orderBy: { timestamp: "asc" },
  },
  windowEvaluations: {
    orderBy: { windowIndex: "asc" },
  },
} satisfies Prisma.SessionRecordInclude;

export type SessionRow = Prisma.SessionRecordGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/** Columns of the lightweight admin overview (counts, not related rows). */
export const SESSION_SUMMARY_SELECT = {
  id: true,
  status: true,
  roundId: true,
  conditionId: true,
  conditionSnapshot: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  waitingDeadlineAt: true,
  roomId: true,
  _count: {
    select: {
      participants: true,
      messages: true,
      interventions: true,
      rankingHistory: true,
    },
  },
} satisfies Prisma.SessionRecordSelect;

type SessionSummaryRow = Prisma.SessionRecordGetPayload<{
  select: typeof SESSION_SUMMARY_SELECT;
}>;

/** A study round as stored (without the derived per-round counts). */
export interface RoundState {
  id: number;
  label: string;
  startedAt: string; // ISO 8601
  endedAt?: string;
}

// ── conditions ─────────────────────────────────────────────────────

export function conditionData(condition: Condition): Prisma.ConditionRecordCreateInput {
  return {
    id: condition.id,
    name: condition.name,
    active: condition.active,
    goal: condition.goal,
    durationMinutes: condition.durationMinutes,
    groupSize: condition.groupSize,
    config: json(condition.config),
  };
}

export function conditionFromRow(row: {
  id: string;
  name: string;
  active: boolean;
  goal: number;
  durationMinutes: number;
  groupSize: number;
  config: Prisma.JsonValue;
}): Condition {
  return normalizeCondition({
    id: row.id,
    name: row.name,
    active: row.active,
    goal: row.goal,
    durationMinutes: row.durationMinutes,
    groupSize: row.groupSize,
    config: fromJson<Condition["config"]>(row.config),
  });
}

// ── sessions ───────────────────────────────────────────────────────

/** Session-row columns written when a session is first stored. */
export function sessionCreateData(
  session: Session,
): Prisma.SessionRecordUncheckedCreateInput {
  return {
    id: session.id,
    status: session.status,
    conditionId: session.condition.id,
    roundId: session.roundId,
    conditionSnapshot: json(session.condition),
    bot: json(session.bot),
    briefing: json(session.briefing),
    rankingTask: json(session.rankingTask),
    ranking: json(session.ranking),
    polls: json(session.polls),
    behavioralEvents: json(session.behavioralEvents),
    classifications: json(session.contributionClassifications),
    classificationFailures: json(session.classificationFailures ?? []),
    processedEventIds: json(session.processedEventIds ?? []),
    runtimeState: json(session.runtimeState ?? {}),
    checkpointRevision: session.checkpointRevision ?? 0,
    durationMinutes: session.durationMinutes,
    roomId: session.roomId,
    waitingDeadlineAt: toOptionalDate(session.waitingDeadlineAt),
    createdAt: toDate(session.createdAt),
    startedAt: toOptionalDate(session.startedAt),
    completedAt: toOptionalDate(session.completedAt),
  };
}

/**
 * Session-row columns a later full save may overwrite. Runtime state goes
 * through the monotonic checkpoint merge instead, and a stored completion
 * time is never cleared.
 */
export function sessionUpdateData(
  session: Session,
): Prisma.SessionRecordUncheckedUpdateInput {
  return {
    status: session.status,
    conditionId: session.condition.id,
    roundId: session.roundId,
    conditionSnapshot: json(session.condition),
    bot: json(session.bot),
    briefing: json(session.briefing),
    rankingTask: json(session.rankingTask),
    polls: json(session.polls),
    durationMinutes: session.durationMinutes,
    roomId: session.roomId,
    waitingDeadlineAt: toOptionalDate(session.waitingDeadlineAt),
    startedAt: toOptionalDate(session.startedAt),
    ...(session.completedAt
      ? { completedAt: toDate(session.completedAt) }
      : {}),
  };
}

export function sessionFromRow(row: SessionRow): Session {
  const rankingHistory = row.rankingHistory.map(
    (entry) => fromJson<Ranking>(entry.ranking),
  );
  return {
    id: row.id,
    status: row.status as Session["status"],
    roundId: row.roundId,
    condition: fromJson<Condition>(row.conditionSnapshot),
    bot: fromJson<BotConfig>(row.bot),
    participants: row.participants.map(participantFromRow),
    chat: {
      messages: row.messages.map(messageFromRow),
    },
    briefing: fromJson<Briefing>(row.briefing),
    rankingTask: fromJson<RankingTask>(row.rankingTask),
    ranking: fromJson<Ranking>(row.ranking),
    rankingHistory,
    interventions: row.interventions.map(
      (intervention) => fromJson<InterventionLog>(intervention.payload),
    ),
    behavioralEvents: fromJson<BehavioralEvent[]>(row.behavioralEvents),
    contributionClassifications: fromJson<ContributionClassification[]>(
      row.classifications,
    ),
    windowEvaluations: dedupeWindowEvaluations(
      row.windowEvaluations.map(
        (evaluation) => fromJson<WindowEvaluation>(evaluation.payload),
      ),
    ),
    classificationFailures: fromJson<ClassificationFailure[]>(
      row.classificationFailures,
    ),
    processedEventIds: fromJson<string[]>(row.processedEventIds),
    redactedReactionEventIds: row.messages.flatMap((message) =>
      message.reactions.flatMap((reaction) =>
        reaction.redacted && reaction.eventId ? [reaction.eventId] : [],
      ),
    ),
    reactionEvents: row.messages.flatMap((message) =>
      message.reactions.flatMap((reaction) =>
        reaction.eventId
          ? [
              {
                eventId: reaction.eventId,
                messageId: message.id,
                key: reaction.key,
                senderId: reaction.senderId,
                timestamp: reaction.timestamp.toISOString(),
                redacted: reaction.redacted,
                redactionEventId: reaction.redactionEventId ?? undefined,
                redactedAt: reaction.redactedAt?.toISOString(),
              },
            ]
          : [],
      ),
    ),
    runtimeState: fromJson<Record<string, unknown>>(row.runtimeState),
    checkpointRevision: row.checkpointRevision,
    polls: fromJson<Poll[]>(row.polls),
    durationMinutes: row.durationMinutes,
    roomId: row.roomId ?? undefined,
    waitingDeadlineAt: row.waitingDeadlineAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

export function sessionSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    status: session.status,
    roundId: session.roundId,
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    participantCount: session.participants.length,
    groupSize: session.condition.groupSize,
    messageCount: session.chat.messages.length,
    interventionCount: session.interventions.length,
    rankingEditCount: session.rankingHistory?.length ?? 0,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    roomId: session.roomId,
    waitingDeadlineAt: session.waitingDeadlineAt,
  };
}

export function sessionSummaryFromRow(row: SessionSummaryRow): SessionSummary {
  const condition = fromJson<Condition>(row.conditionSnapshot);
  return {
    id: row.id,
    status: row.status as SessionSummary["status"],
    roundId: row.roundId,
    conditionId: condition.id,
    conditionName: condition.name,
    participantCount: row._count.participants,
    groupSize: condition.groupSize,
    messageCount: row._count.messages,
    interventionCount: row._count.interventions,
    rankingEditCount: row._count.rankingHistory,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    waitingDeadlineAt: row.waitingDeadlineAt?.toISOString(),
    roomId: row.roomId ?? undefined,
  };
}

// ── participants, surveys, messages ────────────────────────────────

/** Participant-row columns of a newly reserved seat. */
export function participantCreateData(
  sessionId: string,
  participant: Participant,
): Prisma.ParticipantRecordUncheckedCreateInput {
  return {
    id: participant.id,
    sessionId,
    name: participant.name,
    trackingToken: participant.trackingToken,
    recruitmentSource: participant.recruitmentSource,
    prolificPid: participant.prolific?.participantId,
    prolificStudyId: participant.prolific?.studyId,
    prolificSessionId: participant.prolific?.sessionId,
    completedAt: toOptionalDate(participant.completedAt),
  };
}

/** Participant-row columns a full session save may overwrite. */
export function participantUpdateData(
  sessionId: string,
  participant: Participant,
): Prisma.ParticipantRecordUncheckedUpdateInput {
  return {
    sessionId,
    name: participant.name,
    trackingToken: participant.trackingToken,
    recruitmentSource: participant.recruitmentSource,
    prolificPid: participant.prolific?.participantId,
    prolificStudyId: participant.prolific?.studyId,
    prolificSessionId: participant.prolific?.sessionId,
    // A stale aggregate snapshot must never clear compensation
    // eligibility written independently by completeParticipant().
    ...(participant.completedAt
      ? { completedAt: toDate(participant.completedAt) }
      : {}),
  };
}

function participantFromRow(
  row: SessionRow["participants"][number],
): Participant {
  const entry = row.surveys.find((survey) => survey.kind === "entry");
  const exit = row.surveys.find((survey) => survey.kind === "exit");
  return {
    id: row.id,
    name: row.name,
    trackingToken: row.trackingToken,
    recruitmentSource: row.recruitmentSource as Participant["recruitmentSource"],
    prolific:
      row.prolificPid && row.prolificStudyId && row.prolificSessionId
        ? {
            participantId: row.prolificPid,
            studyId: row.prolificStudyId,
            sessionId: row.prolificSessionId,
          }
        : undefined,
    completedAt: row.completedAt?.toISOString(),
    matrixUserId: row.matrixUserId ?? undefined,
    entrySurvey: entry ? surveyFromRow(entry) : undefined,
    exitSurvey: exit ? surveyFromRow(exit) : undefined,
  };
}

function surveyFromRow(row: SessionRow["participants"][number]["surveys"][number]): Survey {
  return {
    answers: fromJson<Survey["answers"]>(row.answers),
    submittedAt: row.submittedAt.toISOString(),
  };
}

function messageFromRow(row: SessionRow["messages"][number]): Message {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    senderId: row.senderId,
    recipientId: row.recipientId,
    text: row.text,
    reactions: row.reactions
      .filter((reaction) => !reaction.redacted)
      .map((reaction) => ({
        ...(reaction.eventId ? { eventId: reaction.eventId } : {}),
        key: reaction.key,
        senderId: reaction.senderId,
        timestamp: reaction.timestamp.toISOString(),
      })),
  };
}

// ── Prolific participation ─────────────────────────────────────────

export function prolificArrivalFromRow(row: {
  prolificPid: string;
  prolificStudyId: string;
  prolificSessionId: string;
  participantRecordId: string | null;
  arrivedAt: Date;
  stage: string;
  stageUpdatedAt: Date;
  lastSeenAt: Date;
  outcome: string | null;
  outcomeReason: string | null;
  endedAt: Date | null;
  elapsedSeconds: number | null;
  compensationKind: string | null;
  compensationAmountPence: number | null;
}): ProlificArrival {
  return {
    participantId: row.prolificPid,
    studyId: row.prolificStudyId,
    sessionId: row.prolificSessionId,
    participantRecordId: row.participantRecordId ?? undefined,
    arrivedAt: row.arrivedAt.toISOString(),
    stage: row.stage as ParticipationStage,
    stageUpdatedAt: row.stageUpdatedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    outcome: (row.outcome as ParticipationOutcome | null) ?? undefined,
    outcomeReason: row.outcomeReason ?? undefined,
    endedAt: row.endedAt?.toISOString(),
    elapsedSeconds: row.elapsedSeconds ?? undefined,
    compensationKind:
      (row.compensationKind as ProlificArrival["compensationKind"]) ?? undefined,
    compensationAmountPence: row.compensationAmountPence ?? undefined,
  };
}

export function participationOutcomeFromRow(
  row: Parameters<typeof prolificArrivalFromRow>[0] & {
    id: string;
    compensation: {
      status: string;
      returnRequestedAt: Date | null;
      bonusBatchId: string | null;
      paymentSubmittedAt: Date | null;
      actionError: string | null;
    } | null;
  },
): ParticipationOutcomeRecord {
  return {
    id: row.id,
    ...prolificArrivalFromRow(row),
    prolificActionStatus:
      (row.compensation?.status as ParticipationOutcomeRecord["prolificActionStatus"]) ??
      undefined,
    returnRequestedAt: row.compensation?.returnRequestedAt?.toISOString(),
    bonusBatchId: row.compensation?.bonusBatchId ?? undefined,
    paymentSubmittedAt:
      row.compensation?.paymentSubmittedAt?.toISOString(),
    actionError: row.compensation?.actionError ?? undefined,
  };
}

// ── rounds ─────────────────────────────────────────────────────────

export function roundFromRow(row: {
  id: number;
  label: string;
  startedAt: Date;
  endedAt: Date | null;
}): RoundState {
  return {
    id: row.id,
    label: row.label,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString(),
  };
}
