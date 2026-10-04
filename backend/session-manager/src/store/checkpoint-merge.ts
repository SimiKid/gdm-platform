import type {
  CheckpointSessionRequest,
  Message,
  Ranking,
  Reaction,
  RecordedReaction,
  RuntimeCheckpoint,
  Session,
} from "@gdm/shared";
import { dedupeWindowEvaluations } from "./window-evaluations";

/**
 * Monotonic checkpoint merge rules shared by the in-memory store and the
 * Prisma persistence (runtime-checkpoint.ts): collections only ever grow,
 * and mutable state is replaced only by a checkpoint at least as new as the
 * stored revision.
 */

/** The full runtime state of a session as one checkpoint. */
export function checkpointFromSession(session: Session): RuntimeCheckpoint {
  return {
    revision: session.checkpointRevision,
    messages: session.chat.messages,
    rankingHistory: session.rankingHistory ?? [],
    interventions: session.interventions,
    behavioralEvents: session.behavioralEvents,
    contributionClassifications: session.contributionClassifications,
    windowEvaluations: session.windowEvaluations ?? [],
    classificationFailures: session.classificationFailures ?? [],
    processedEventIds: session.processedEventIds ?? [],
    redactedReactionEventIds: session.redactedReactionEventIds ?? [],
    reactionEvents: session.reactionEvents ?? [],
    ruleState: session.runtimeState ?? {},
  };
}

/**
 * Whether a checkpoint may replace mutable state: an unversioned one always
 * may, a versioned one only when it is not older than the stored revision.
 */
export function acceptsCheckpointState(
  incomingRevision: number | undefined,
  storedRevision: number,
): boolean {
  return incomingRevision === undefined || incomingRevision >= storedRevision;
}

/** In-memory equivalent of the durable, monotonic checkpoint merge. */
export function mergeCheckpointIntoSession(
  session: Session,
  checkpoint: CheckpointSessionRequest,
): void {
  if (session.condition.config.workspaceMode === "etherpad") checkpoint = withoutRanking(checkpoint);
  const incomingRevision = checkpoint.revision;
  const acceptsMutableState = acceptsCheckpointState(
    incomingRevision,
    session.checkpointRevision ?? 0,
  );
  const hadRankingHistory = (session.rankingHistory?.length ?? 0) > 0;
  session.reactionEvents = mergeRecordedReactions(
    session.reactionEvents ?? [],
    checkpoint.reactionEvents ?? [],
  );
  const redactedReactionEventIds = new Set([
    ...(session.redactedReactionEventIds ?? []),
    ...(checkpoint.redactedReactionEventIds ?? []),
    ...session.reactionEvents
      .filter((reaction) => reaction.redacted)
      .map((reaction) => reaction.eventId),
  ]);
  session.redactedReactionEventIds = [...redactedReactionEventIds];
  session.chat.messages = mergeMessages(
    session.chat.messages,
    checkpoint.messages ?? [],
    redactedReactionEventIds,
  );
  session.rankingHistory = appendUnique(
    session.rankingHistory ?? [],
    checkpoint.rankingHistory ?? [],
    rankingKey,
  );
  session.interventions = mergeByKey(
    session.interventions,
    checkpoint.interventions ?? [],
    (intervention) => intervention.id,
  );
  session.behavioralEvents = mergeCheckpointValues(
    session.behavioralEvents,
    checkpoint.behavioralEvents ?? [],
    (event) => event.id,
    acceptsMutableState,
  );
  session.contributionClassifications = mergeCheckpointValues(
    session.contributionClassifications,
    checkpoint.contributionClassifications ?? [],
    (classification) => classification.messageId,
    acceptsMutableState,
  );
  session.windowEvaluations = dedupeWindowEvaluations(
    mergeByKey(
      session.windowEvaluations ?? [],
      checkpoint.windowEvaluations ?? [],
      (evaluation) => evaluation.id,
    ),
  );
  session.classificationFailures = mergeCheckpointValues(
    session.classificationFailures ?? [],
    checkpoint.classificationFailures ?? [],
    (failure) => failure.messageId,
    acceptsMutableState,
  );
  session.processedEventIds = [
    ...new Set([
      ...(session.processedEventIds ?? []),
      ...(checkpoint.processedEventIds ?? []),
    ]),
  ];
  if (acceptsMutableState) {
    session.runtimeState = {
      ...session.runtimeState,
      ...checkpoint.ruleState,
    };
    if (incomingRevision !== undefined) {
      session.checkpointRevision = incomingRevision;
    }
  }
  if (
    acceptsMutableState &&
    (checkpoint.rankingHistory?.length ?? 0) > 0
  ) {
    session.ranking =
      incomingRevision !== undefined || !hadRankingHistory
        ? checkpoint.rankingHistory!.at(-1)!
        : newestRanking(session.ranking, ...(checkpoint.rankingHistory ?? []));
  }
}

/** An Etherpad session has no shared ranking: drop ranking state and moves. */
export function withoutRanking(checkpoint: CheckpointSessionRequest): CheckpointSessionRequest {
  return { ...checkpoint, rankingHistory: [], behavioralEvents: checkpoint.behavioralEvents?.filter(e => e.type !== "ranking-move") };
}

function mergeMessages(
  existing: Message[],
  incoming: Message[],
  redactedReactionEventIds: ReadonlySet<string>,
): Message[] {
  const merged = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const current = merged.get(message.id);
    if (!current) {
      merged.set(message.id, {
        ...message,
        reactions: message.reactions.filter(
          (reaction) =>
            !reaction.eventId ||
            !redactedReactionEventIds.has(reaction.eventId),
        ),
      });
      continue;
    }
    const seenReactions = new Set(
      current.reactions
        .filter(
          (reaction) =>
            !reaction.eventId ||
            !redactedReactionEventIds.has(reaction.eventId),
        )
        .map((reaction) => reactionIdentityKey(message.id, reaction)),
    );
    const reactions = current.reactions.filter(
      (reaction) =>
        !reaction.eventId ||
        !redactedReactionEventIds.has(reaction.eventId),
    );
    for (const reaction of message.reactions) {
      if (
        reaction.eventId &&
        redactedReactionEventIds.has(reaction.eventId)
      ) {
        continue;
      }
      const key = reactionIdentityKey(message.id, reaction);
      if (seenReactions.has(key)) continue;
      seenReactions.add(key);
      reactions.push(reaction);
    }
    merged.set(message.id, { ...current, reactions });
  }
  return [...merged.values()];
}

function mergeRecordedReactions(
  existing: RecordedReaction[],
  incoming: RecordedReaction[],
): RecordedReaction[] {
  const merged = new Map(existing.map((reaction) => [reaction.eventId, reaction]));
  for (const reaction of incoming) {
    const current = merged.get(reaction.eventId);
    if (!current) {
      merged.set(reaction.eventId, reaction);
      continue;
    }
    merged.set(reaction.eventId, {
      ...current,
      ...reaction,
      redacted: current.redacted || reaction.redacted,
      redactionEventId:
        reaction.redactionEventId ?? current.redactionEventId,
      redactedAt: reaction.redactedAt ?? current.redactedAt,
    });
  }
  return [...merged.values()];
}

function reactionIdentityKey(messageId: string, reaction: Reaction): string {
  return reaction.eventId
    ? `event:${reaction.eventId}`
    : reactionKey(messageId, reaction.key, reaction.senderId);
}

function appendUnique<T>(
  existing: T[],
  incoming: T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(existing.map(key));
  const appended = [...existing];
  for (const item of incoming) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    appended.push(item);
  }
  return appended;
}

/** Identity of one ranking state: its Matrix event, else its full content. */
export function rankingKey(ranking: Ranking): string {
  if (ranking.eventId) return `event:${ranking.eventId}`;
  const movement = ranking.movement
    ? `${ranking.movement.itemId}:${ranking.movement.from}:${ranking.movement.to}`
    : "";
  return [
    ranking.taskId,
    ranking.updatedAt,
    ranking.updatedBy,
    ranking.order.join("\u0001"),
    movement,
  ].join("\u0000");
}

/** The latest ranking by `updatedAt`; unparsable timestamps never win. */
export function newestRanking(first: Ranking, ...rest: Ranking[]): Ranking {
  return rest.reduce((latest, candidate) => {
    const latestTime = Date.parse(latest.updatedAt);
    const candidateTime = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(candidateTime)) return latest;
    if (!Number.isFinite(latestTime) || candidateTime >= latestTime) {
      return candidate;
    }
    return latest;
  }, first);
}

/**
 * Newer snapshots may replace a value with the same logical key (for example
 * a retried classification). A late snapshot may only contribute previously
 * unseen records; it cannot roll a newer value back.
 */
export function mergeCheckpointValues<T>(
  existing: T[],
  incoming: T[],
  key: (item: T) => string,
  acceptsReplacement: boolean,
): T[] {
  return acceptsReplacement
    ? mergeByKey(existing, incoming, (item) => key(item))
    : appendUnique(existing, incoming, key);
}

function mergeByKey<T>(
  existing: T[],
  incoming: T[],
  key: (item: T, index: number) => string,
): T[] {
  const merged = new Map<string, T>();
  existing.forEach((item, index) => merged.set(key(item, index), item));
  incoming.forEach((item, index) => merged.set(key(item, index), item));
  return [...merged.values()];
}

/** Semantic identity of a reaction without a Matrix event id (legacy rows). */
export function reactionKey(messageId: string, key: string, senderId: string): string {
  return `${messageId}\u0000${key}\u0000${senderId}`;
}
