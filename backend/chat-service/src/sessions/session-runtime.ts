import { GDM_RECIPIENT_KEY, isServiceUser } from "@gdm/shared";
import type {
  BehavioralEvent,
  ClassificationFailure,
  Condition,
  ContributionClassification,
  InterventionLog,
  Message,
  Ranking,
  RecordedReaction,
  Reaction,
  RuntimeCheckpoint,
  WindowEvaluation,
} from "@gdm/shared";
import type { MatrixBotService } from "../matrix/matrix-bot.service";

/**
 * The live state of one running session, owned by the Chat Service.
 *
 * Collects the discussion (messages + reactions) and the shared-ranking
 * history as they happen, and exposes helpers the bot rules use to intervene.
 * At session end it's serialised and handed back to the Session Manager.
 */
export class SessionRuntime {
  /** The chat log so far; each message carries its aggregated reactions. */
  readonly messages: Message[] = [];
  /** Every shared-ranking state seen this session, oldest → newest. */
  readonly rankingHistory: Ranking[] = [];
  /** Every bot intervention emitted this session. */
  readonly interventions: InterventionLog[] = [];
  readonly behavioralEvents: BehavioralEvent[] = [];
  readonly contributionClassifications: ContributionClassification[] = [];
  /** One record per evaluated contribution-window boundary, fired or not. */
  readonly windowEvaluations: WindowEvaluation[] = [];
  /** Classification requests that produced no usable result. */
  readonly classificationFailures: ClassificationFailure[] = [];
  /** Rules may stash arbitrary per-session bookkeeping here. */
  readonly state: Record<string, unknown> = {};

  readonly startedAtMs: number;
  private ended = false;
  private readonly byId = new Map<string, Message>();
  /** reaction event id -> where it landed, so redactions can undo it. */
  private readonly reactionEvents = new Map<
    string,
    { message: Message; reaction: Reaction }
  >();
  private readonly recordedReactions = new Map<string, RecordedReaction>();
  private readonly redactedReactionEventIds = new Set<string>();
  private readonly processedEventIds = new Set<string>();
  private participantUserIds?: Promise<string[]>;
  /** Monotonic snapshot revision; restored after a Chat Service restart. */
  private checkpointRevision = 0;

  constructor(
    readonly sessionId: string,
    readonly roomId: string,
    readonly condition: Condition,
    readonly durationMinutes: number,
    private readonly bot: MatrixBotService,
    startedAt?: string,
    checkpoint?: RuntimeCheckpoint,
  ) {
    this.startedAtMs = startedAt ? new Date(startedAt).getTime() : Date.now();
    if (checkpoint) this.restore(checkpoint);
  }

  recordMessage(message: Message): void {
    if (this.byId.has(message.id)) return;
    this.messages.push(message);
    this.byId.set(message.id, message);
  }

  /** Attach a reaction to its target message (if we've seen it). */
  addReaction(
    reactionEventId: string,
    targetMessageId: string,
    reaction: Reaction,
  ): void {
    const recorded = this.recordedReactions.get(reactionEventId) ?? {
      ...reaction,
      eventId: reactionEventId,
      messageId: targetMessageId,
      redacted: this.redactedReactionEventIds.has(reactionEventId),
    };
    this.recordedReactions.set(reactionEventId, recorded);
    if (recorded.redacted) return;
    const message = this.byId.get(targetMessageId);
    if (!message) return;
    let stored = message.reactions.find(
      (candidate) =>
        candidate.eventId === reactionEventId ||
        (!candidate.eventId &&
          candidate.key === reaction.key &&
          candidate.senderId === reaction.senderId),
    );
    if (!stored) {
      stored = { ...reaction, eventId: reactionEventId };
      message.reactions.push(stored);
    } else if (!stored.eventId) {
      stored.eventId = reactionEventId;
    }
    this.reactionEvents.set(reactionEventId, { message, reaction: stored });
  }

  /** Undo a reaction that was redacted (toggled off). */
  removeRedacted(
    redactedEventId: string,
    redactionEventId?: string,
    redactedAt?: string,
  ): void {
    const entry =
      this.reactionEvents.get(redactedEventId) ??
      this.findReactionEvent(redactedEventId);
    const recorded = this.recordedReactions.get(redactedEventId);
    // Matrix also uses m.room.redaction for messages. Only create a reaction
    // tombstone when the target is known to be an annotation event.
    if (!entry && !recorded) return;
    this.redactedReactionEventIds.add(redactedEventId);
    if (recorded) {
      recorded.redacted = true;
      if (redactionEventId) recorded.redactionEventId = redactionEventId;
      if (redactedAt) recorded.redactedAt = redactedAt;
    }
    if (!entry) return;
    const idx = entry.message.reactions.indexOf(entry.reaction);
    if (idx >= 0) entry.message.reactions.splice(idx, 1);
    this.reactionEvents.delete(redactedEventId);
  }

  recordRanking(ranking: Ranking): void {
    if (
      ranking.eventId &&
      this.rankingHistory.some((item) => item.eventId === ranking.eventId)
    ) {
      return;
    }
    this.rankingHistory.push(ranking);
  }

  recordBehavior(event: BehavioralEvent): void {
    if (this.behavioralEvents.some((item) => item.id === event.id)) return;
    this.behavioralEvents.push(event);
  }

  recordClassification(classification: ContributionClassification): void {
    const index = this.contributionClassifications.findIndex(
      (item) => item.messageId === classification.messageId,
    );
    if (index >= 0) this.contributionClassifications[index] = classification;
    else this.contributionClassifications.push(classification);
  }

  recordWindowEvaluation(evaluation: WindowEvaluation): void {
    this.windowEvaluations.push(evaluation);
  }

  recordClassificationFailure(failure: ClassificationFailure): void {
    const index = this.classificationFailures.findIndex(
      (item) => item.messageId === failure.messageId,
    );
    if (index >= 0) this.classificationFailures[index] = failure;
    else this.classificationFailures.push(failure);
  }

  hasProcessed(eventId: string): boolean {
    return this.processedEventIds.has(eventId);
  }

  markProcessed(eventId: string): void {
    this.processedEventIds.add(eventId);
  }

  checkpoint(): RuntimeCheckpoint {
    this.checkpointRevision += 1;
    return {
      revision: this.checkpointRevision,
      messages: this.messages,
      rankingHistory: this.rankingHistory,
      interventions: this.interventions,
      behavioralEvents: this.behavioralEvents,
      contributionClassifications: this.contributionClassifications,
      windowEvaluations: this.windowEvaluations,
      classificationFailures: this.classificationFailures,
      processedEventIds: [...this.processedEventIds],
      redactedReactionEventIds: [...this.redactedReactionEventIds],
      reactionEvents: [...this.recordedReactions.values()],
      ruleState: this.state,
    };
  }

  recordIntervention(intervention: InterventionLog): void {
    this.interventions.push(intervention);
  }

  async getParticipantUserIds(): Promise<string[]> {
    this.participantUserIds ??= this.bot
      .getJoinedMemberIds(this.roomId)
      .then((memberIds) =>
        memberIds.filter((id) => !isServiceUser(id)).sort(),
      )
      .catch((error: unknown) => {
        this.participantUserIds = undefined;
        throw error;
      });
    return this.participantUserIds;
  }

  /** Post a nudge / message into the room as the bot (visible to everyone). */
  post(body: string): Promise<void> {
    return this.bot.sendText(this.roomId, body);
  }

  /** Post a private nudge that the client renders only to `recipientId`. */
  postPrivate(recipientId: string, body: string): Promise<void> {
    return this.bot.sendText(this.roomId, body, {
      [GDM_RECIPIENT_KEY]: recipientId,
    });
  }

  /**
   * Post as a named comparison bot ("a" / "b") instead of the primary bot.
   * With `recipientId` set, the client renders it only to that participant
   * (same mechanism as postPrivate).
   */
  postAs(botKind: string, body: string, recipientId?: string): Promise<void> {
    if (recipientId) {
      return this.bot.sendTextAs(botKind, this.roomId, body, {
        [GDM_RECIPIENT_KEY]: recipientId,
      });
    }
    return this.bot.sendTextAs(botKind, this.roomId, body);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  markEnded(): void {
    this.ended = true;
  }

  private restore(checkpoint: RuntimeCheckpoint): void {
    this.checkpointRevision = Math.max(0, checkpoint.revision ?? 0);
    for (const reaction of checkpoint.reactionEvents ?? []) {
      const restored = { ...reaction };
      this.recordedReactions.set(restored.eventId, restored);
      if (restored.redacted) {
        this.redactedReactionEventIds.add(restored.eventId);
      }
    }
    for (const eventId of checkpoint.redactedReactionEventIds ?? []) {
      this.redactedReactionEventIds.add(eventId);
    }
    this.messages.push(...checkpoint.messages);
    for (const message of this.messages) {
      message.reactions = message.reactions.filter(
        (reaction) =>
          !reaction.eventId ||
          !this.redactedReactionEventIds.has(reaction.eventId),
      );
      this.byId.set(message.id, message);
      for (const reaction of message.reactions) {
        if (reaction.eventId) {
          if (!this.recordedReactions.has(reaction.eventId)) {
            this.recordedReactions.set(reaction.eventId, {
              ...reaction,
              eventId: reaction.eventId,
              messageId: message.id,
              redacted: false,
            });
          }
          this.reactionEvents.set(reaction.eventId, { message, reaction });
        }
      }
    }
    this.rankingHistory.push(...checkpoint.rankingHistory);
    this.interventions.push(...checkpoint.interventions);
    this.behavioralEvents.push(...checkpoint.behavioralEvents);
    this.contributionClassifications.push(...checkpoint.contributionClassifications);
    // Checkpoints written before these fields existed omit them.
    this.windowEvaluations.push(...(checkpoint.windowEvaluations ?? []));
    this.classificationFailures.push(...(checkpoint.classificationFailures ?? []));
    for (const eventId of checkpoint.processedEventIds) {
      this.processedEventIds.add(eventId);
    }
    Object.assign(this.state, checkpoint.ruleState);
  }

  private findReactionEvent(
    eventId: string,
  ): { message: Message; reaction: Reaction } | undefined {
    for (const message of this.messages) {
      const reaction = message.reactions.find((item) => item.eventId === eventId);
      if (reaction) return { message, reaction };
    }
    return undefined;
  }
}
