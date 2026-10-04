import type { Prisma } from "@prisma/client";
import type {
  BehavioralEvent,
  CheckpointSessionRequest,
  ClassificationFailure,
  Condition,
  ContributionClassification,
  InterventionLog,
  Message,
  Ranking,
  RecordedReaction,
  WindowEvaluation,
} from "@gdm/shared";
import {
  acceptsCheckpointState,
  mergeCheckpointValues,
  newestRanking,
  rankingKey,
  reactionKey,
  withoutRanking,
} from "./checkpoint-merge";
import { fromJson, json, toDate, toOptionalDate } from "./prisma-values";

type Tx = Prisma.TransactionClient;

/** The stored session state a checkpoint is merged into. */
const CHECKPOINT_BASE_SELECT = {
  ranking: true,
  conditionSnapshot: true,
  rankingHistory: {
    select: { position: true, ranking: true },
    orderBy: { position: "asc" },
  },
  behavioralEvents: true,
  classifications: true,
  classificationFailures: true,
  processedEventIds: true,
  runtimeState: true,
  checkpointRevision: true,
} satisfies Prisma.SessionRecordSelect;

type CheckpointBase = Prisma.SessionRecordGetPayload<{
  select: typeof CHECKPOINT_BASE_SELECT;
}>;

/**
 * Merge a full Chat Service snapshot into normalized research tables.
 * Every operation is idempotent. No message/ranking/intervention row is
 * deleted, which makes retrying after a timeout safe and crash-resilient.
 */
export async function persistRuntimeCheckpoint(
  tx: Tx,
  sessionId: string,
  checkpoint: CheckpointSessionRequest,
): Promise<void> {
  const current = await tx.sessionRecord.findUnique({
    where: { id: sessionId },
    select: CHECKPOINT_BASE_SELECT,
  });
  if (!current) throw new Error(`Unknown session ${sessionId}`);
  if (fromJson<Condition>(current.conditionSnapshot).config.workspaceMode === "etherpad") checkpoint = withoutRanking(checkpoint);

  await insertMessages(tx, sessionId, checkpoint.messages ?? []);
  await insertReactionEvents(tx, checkpoint.reactionEvents ?? []);
  await markReactionsRedacted(tx, checkpoint.redactedReactionEventIds ?? []);
  const storedRankings = current.rankingHistory.map((entry) =>
    fromJson<Ranking>(entry.ranking),
  );
  await appendRankingHistory(
    tx,
    sessionId,
    current,
    storedRankings,
    checkpoint.rankingHistory ?? [],
  );
  await insertInterventions(tx, sessionId, checkpoint.interventions ?? []);
  await insertWindowEvaluations(tx, sessionId, checkpoint.windowEvaluations ?? []);
  await tx.sessionRecord.update({
    where: { id: sessionId },
    data: mergedSessionState(current, storedRankings, checkpoint),
  });
}

/** New messages plus their not-yet-stored reactions. */
async function insertMessages(
  tx: Tx,
  sessionId: string,
  messages: Message[],
): Promise<void> {
  if (messages.length === 0) return;
  await tx.messageRecord.createMany({
    data: messages.map((message) => ({
      id: message.id,
      sessionId,
      timestamp: toDate(message.timestamp),
      senderId: message.senderId,
      recipientId: message.recipientId ?? null,
      text: message.text,
    })),
    skipDuplicates: true,
  });

  // New checkpoints carry the immutable Matrix annotation event id. Keep
  // legacy semantic matching only to upgrade pre-migration active rows.
  const messageIds = messages.map((message) => message.id);
  const existingReactions = await tx.reactionRecord.findMany({
    where: { messageId: { in: messageIds } },
    select: {
      id: true,
      eventId: true,
      messageId: true,
      key: true,
      senderId: true,
    },
  });
  const seenEventIds = new Set(
    existingReactions.flatMap((reaction) =>
      reaction.eventId ? [reaction.eventId] : [],
    ),
  );
  const legacyByKey = new Map(
    existingReactions
      .filter((reaction) => !reaction.eventId)
      .map((reaction) => [
        reactionKey(reaction.messageId, reaction.key, reaction.senderId),
        reaction.id,
      ]),
  );
  const legacySeen = new Set(legacyByKey.keys());
  const reactions: Prisma.ReactionRecordCreateManyInput[] = [];
  for (const message of messages) {
    for (const reaction of message.reactions) {
      const key = reactionKey(message.id, reaction.key, reaction.senderId);
      if (reaction.eventId) {
        if (seenEventIds.has(reaction.eventId)) continue;
        const legacyId = legacyByKey.get(key);
        if (legacyId) {
          await tx.reactionRecord.update({
            where: { id: legacyId },
            data: { eventId: reaction.eventId },
          });
          legacyByKey.delete(key);
        } else {
          reactions.push({
            eventId: reaction.eventId,
            messageId: message.id,
            key: reaction.key,
            senderId: reaction.senderId,
            timestamp: toDate(reaction.timestamp),
          });
        }
        seenEventIds.add(reaction.eventId);
        continue;
      }
      if (legacySeen.has(key)) continue;
      legacySeen.add(key);
      reactions.push({
        messageId: message.id,
        key: reaction.key,
        senderId: reaction.senderId,
        timestamp: toDate(reaction.timestamp),
      });
    }
  }
  if (reactions.length > 0) {
    await tx.reactionRecord.createMany({ data: reactions, skipDuplicates: true });
  }
}

/** Every recorded reaction event, active or redacted. */
async function insertReactionEvents(
  tx: Tx,
  reactionEvents: RecordedReaction[],
): Promise<void> {
  if (reactionEvents.length === 0) return;
  await tx.reactionRecord.createMany({
    data: reactionEvents.map((reaction) => ({
      eventId: reaction.eventId,
      messageId: reaction.messageId,
      key: reaction.key,
      senderId: reaction.senderId,
      timestamp: toDate(reaction.timestamp),
      redacted: reaction.redacted,
      redactionEventId: reaction.redactionEventId,
      redactedAt: toOptionalDate(reaction.redactedAt),
    })),
    skipDuplicates: true,
  });
  // Redaction is monotonic. Never let a late active snapshot resurrect a
  // reaction event that a newer checkpoint has already marked inactive.
  for (const reaction of reactionEvents) {
    if (!reaction.redacted) continue;
    await tx.reactionRecord.updateMany({
      where: { eventId: reaction.eventId },
      data: {
        redacted: true,
        ...(reaction.redactionEventId
          ? { redactionEventId: reaction.redactionEventId }
          : {}),
        ...(reaction.redactedAt
          ? { redactedAt: toDate(reaction.redactedAt) }
          : {}),
      },
    });
  }
}

async function markReactionsRedacted(
  tx: Tx,
  redactedReactionEventIds: string[],
): Promise<void> {
  if (redactedReactionEventIds.length === 0) return;
  await tx.reactionRecord.updateMany({
    where: { eventId: { in: redactedReactionEventIds } },
    data: { redacted: true },
  });
}

/** Append unseen ranking states after the stored history. */
async function appendRankingHistory(
  tx: Tx,
  sessionId: string,
  current: CheckpointBase,
  storedRankings: Ranking[],
  rankingHistory: Ranking[],
): Promise<void> {
  const seenRankings = new Set(storedRankings.map(rankingKey));
  const newRankings = rankingHistory.filter((ranking) => {
    const key = rankingKey(ranking);
    if (seenRankings.has(key)) return false;
    seenRankings.add(key);
    return true;
  });
  if (newRankings.length === 0) return;
  const nextPosition =
    Math.max(-1, ...current.rankingHistory.map((entry) => entry.position)) + 1;
  await tx.rankingHistoryRecord.createMany({
    data: newRankings.map((ranking, offset) => ({
      sessionId,
      position: nextPosition + offset,
      ranking: json(ranking),
      updatedAt: toDate(ranking.updatedAt),
    })),
  });
}

async function insertInterventions(
  tx: Tx,
  sessionId: string,
  interventions: InterventionLog[],
): Promise<void> {
  if (interventions.length === 0) return;
  await tx.interventionRecord.createMany({
    data: interventions.map((intervention) => ({
      id: intervention.id,
      sessionId,
      roomId: intervention.roomId,
      conditionId: intervention.conditionId,
      mode: intervention.mode,
      audience: intervention.audience,
      timestamp: toDate(intervention.timestamp),
      trigger: intervention.trigger,
      threshold: intervention.threshold,
      contributionWindowMinutes: intervention.contributionWindowMinutes,
      message: intervention.message,
      payload: json(intervention),
    })),
    skipDuplicates: true,
  });
}

async function insertWindowEvaluations(
  tx: Tx,
  sessionId: string,
  evaluations: WindowEvaluation[],
): Promise<void> {
  if (evaluations.length === 0) return;
  await tx.windowEvaluationRecord.createMany({
    data: evaluations.map((evaluation) => ({
      id: evaluation.id,
      sessionId,
      conditionId: evaluation.conditionId,
      windowIndex: evaluation.windowIndex,
      windowStart: toDate(evaluation.windowStart),
      windowEnd: toDate(evaluation.windowEnd),
      outcome: evaluation.outcome,
      llmMode: evaluation.llmMode,
      payload: json(evaluation),
    })),
    skipDuplicates: true,
  });
}

/**
 * The session row's JSON state after the merge. Mutable values (ranking,
 * rule state, revision, replaced records) change only when the checkpoint
 * is not older than the stored revision.
 */
function mergedSessionState(
  current: CheckpointBase,
  storedRankings: Ranking[],
  checkpoint: CheckpointSessionRequest,
): Prisma.SessionRecordUpdateInput {
  const incomingRevision = checkpoint.revision;
  const acceptsMutableState = acceptsCheckpointState(
    incomingRevision,
    current.checkpointRevision,
  );
  const rankingHistory = checkpoint.rankingHistory ?? [];
  const currentBehavior = fromJson<BehavioralEvent[]>(current.behavioralEvents);
  const currentClassifications = fromJson<ContributionClassification[]>(
    current.classifications,
  );
  const currentFailures = fromJson<ClassificationFailure[]>(
    current.classificationFailures,
  );
  const currentProcessed = fromJson<string[]>(current.processedEventIds);
  const currentRuleState = fromJson<Record<string, unknown>>(current.runtimeState);
  const latestRanking =
    incomingRevision !== undefined
      ? (rankingHistory.at(-1) ?? fromJson<Ranking>(current.ranking))
      : storedRankings.length === 0
        ? (rankingHistory.at(-1) ?? fromJson<Ranking>(current.ranking))
        : newestRanking(fromJson<Ranking>(current.ranking), ...rankingHistory);

  return {
    ...(acceptsMutableState && rankingHistory.length > 0
      ? { ranking: json(latestRanking) }
      : {}),
    behavioralEvents: json(
      mergeCheckpointValues(
        currentBehavior,
        checkpoint.behavioralEvents ?? [],
        (event) => event.id,
        acceptsMutableState,
      ),
    ),
    classifications: json(
      mergeCheckpointValues(
        currentClassifications,
        checkpoint.contributionClassifications ?? [],
        (classification) => classification.messageId,
        acceptsMutableState,
      ),
    ),
    classificationFailures: json(
      mergeCheckpointValues(
        currentFailures,
        checkpoint.classificationFailures ?? [],
        (failure) => failure.messageId,
        acceptsMutableState,
      ),
    ),
    processedEventIds: json([
      ...new Set([...currentProcessed, ...(checkpoint.processedEventIds ?? [])]),
    ]),
    runtimeState: acceptsMutableState
      ? json({
          ...currentRuleState,
          ...checkpoint.ruleState,
        })
      : json(currentRuleState),
    ...(acceptsMutableState && incomingRevision !== undefined
      ? { checkpointRevision: incomingRevision }
      : {}),
  };
}
