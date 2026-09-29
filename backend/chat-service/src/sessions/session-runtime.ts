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
  RuntimeCheckpoint,
  WindowEvaluation,
} from "@gdm/shared";
import type { MatrixBotService } from "../matrix/matrix-bot.service";

/**
 * The live state of one running session, owned by the Chat Service.
 *
 * Collects the discussion (messages) and the shared-ranking history as they
 * happen, and exposes helpers the bot rules use to intervene.
 * At session end it's serialised and handed back to the Session Manager.
 */
export class SessionRuntime {
  /** The chat log so far, oldest → newest. */
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
  /**
   * Reaction audit data restored from checkpoints written while emoji
   * reactions were still recorded. Reactions are no longer ingested (the
   * participant UI cannot produce them); these are passed through unchanged
   * so a restore → checkpoint round-trip never drops historical data.
   */
  private readonly legacyReactionEvents: RecordedReaction[] = [];
  private readonly legacyRedactedReactionEventIds: string[] = [];
  private readonly processedEventIds = new Set<string>();
  private participantUserIds?: Promise<string[]>;
  /** Monotonic snapshot revision; restored after a Chat Service restart. */
  private checkpointRevision = 0;
  /** End of the latest window boundary handed to the rules; restored too. */
  private lastWindowBoundaryMs = 0;

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

  /**
   * Claim a window boundary for evaluation. False when this boundary — or a
   * later one — was already claimed or restored: evaluating a boundary twice
   * records a second (after a nudge, all-zero) copy of the same window.
   */
  claimWindowBoundary(windowEndMs: number): boolean {
    if (windowEndMs <= this.lastWindowBoundaryMs) return false;
    this.lastWindowBoundaryMs = windowEndMs;
    return true;
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
      redactedReactionEventIds: [...this.legacyRedactedReactionEventIds],
      reactionEvents: [...this.legacyReactionEvents],
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

  get isEnded(): boolean {
    return this.ended;
  }

  markEnded(): void {
    this.ended = true;
  }

  private restore(checkpoint: RuntimeCheckpoint): void {
    this.checkpointRevision = Math.max(0, checkpoint.revision ?? 0);
    // Checkpoints written before the reaction fields existed omit them.
    this.legacyReactionEvents.push(...(checkpoint.reactionEvents ?? []));
    this.legacyRedactedReactionEventIds.push(
      ...(checkpoint.redactedReactionEventIds ?? []),
    );
    this.messages.push(...checkpoint.messages);
    for (const message of this.messages) this.byId.set(message.id, message);
    this.rankingHistory.push(...checkpoint.rankingHistory);
    this.interventions.push(...checkpoint.interventions);
    this.behavioralEvents.push(...checkpoint.behavioralEvents);
    this.contributionClassifications.push(...checkpoint.contributionClassifications);
    // Checkpoints written before these fields existed omit them.
    this.windowEvaluations.push(...(checkpoint.windowEvaluations ?? []));
    for (const evaluation of this.windowEvaluations) {
      const endMs = Date.parse(evaluation.windowEnd);
      if (Number.isFinite(endMs)) {
        this.lastWindowBoundaryMs = Math.max(this.lastWindowBoundaryMs, endMs);
      }
    }
    this.classificationFailures.push(...(checkpoint.classificationFailures ?? []));
    for (const eventId of checkpoint.processedEventIds) {
      this.processedEventIds.add(eventId);
    }
    Object.assign(this.state, checkpoint.ruleState);
  }
}
