import { GDM_RECIPIENT_KEY, isServiceUser } from "@gdm/shared";
import type {
  Condition,
  InterventionLog,
  Message,
  Ranking,
  Reaction,
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

  constructor(
    readonly sessionId: string,
    readonly roomId: string,
    readonly condition: Condition,
    readonly durationMinutes: number,
    private readonly bot: MatrixBotService,
  ) {
    this.startedAtMs = Date.now();
  }

  recordMessage(message: Message): void {
    this.messages.push(message);
    this.byId.set(message.id, message);
  }

  /** Attach a reaction to its target message (if we've seen it). */
  addReaction(
    reactionEventId: string,
    targetMessageId: string,
    reaction: Reaction,
  ): void {
    const message = this.byId.get(targetMessageId);
    if (!message) return;
    message.reactions.push(reaction);
    this.reactionEvents.set(reactionEventId, { message, reaction });
  }

  /** Undo a reaction that was redacted (toggled off). */
  removeRedacted(redactedEventId: string): void {
    const entry = this.reactionEvents.get(redactedEventId);
    if (!entry) return;
    const idx = entry.message.reactions.indexOf(entry.reaction);
    if (idx >= 0) entry.message.reactions.splice(idx, 1);
    this.reactionEvents.delete(redactedEventId);
  }

  recordRanking(ranking: Ranking): void {
    this.rankingHistory.push(ranking);
  }

  recordIntervention(intervention: InterventionLog): void {
    this.interventions.push(intervention);
  }

  async getParticipantUserIds(): Promise<string[]> {
    const memberIds = await this.bot.getJoinedMemberIds(this.roomId);
    return memberIds.filter((id) => !isServiceUser(id)).sort();
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
}
