import { Inject, Injectable, Logger } from "@nestjs/common";
import { MATRIX_EVENT_TYPES } from "@gdm/shared";
import type {
  Message,
  Ranking,
  Reaction,
  StartSessionNotification,
} from "@gdm/shared";
import {
  MatrixBotService,
  type TimelineEvent,
} from "../matrix/matrix-bot.service";
import { SessionRuntime } from "./session-runtime";
import { BOT_RULES } from "../rules/bot-rules.token";
import type { BotRules } from "../rules/bot-rules";

/**
 * Owns the live sessions the Chat Service is running. Started by the Session
 * Manager (POST /internal/sessions/start), it joins the room, tails the stream
 * into a SessionRuntime, runs the rules, and finalises the data back to the
 * Session Manager when the discussion timer ends.
 */
@Injectable()
export class SessionsService {
  private readonly log = new Logger(SessionsService.name);
  private readonly sessionManagerUrl =
    process.env.SESSION_MANAGER_URL ?? "http://localhost:3001/api";
  /** roomId -> live runtime. */
  private readonly runtimes = new Map<string, SessionRuntime>();
  /**
   * roomId -> tail of the rule-evaluation chain. Rules await network calls
   * mid-evaluation, so events must be processed one at a time per room or
   * the intervention-window bookkeeping races (double nudges on a burst).
   */
  private readonly ruleChains = new Map<string, Promise<void>>();

  constructor(
    private readonly bot: MatrixBotService,
    @Inject(BOT_RULES) private readonly rules: BotRules,
  ) {
    this.bot.onTimelineEvent((event) => this.handleEvent(event));
  }

  /** Take over a freshly-provisioned session. */
  async startSession(note: StartSessionNotification): Promise<void> {
    if (this.runtimes.has(note.roomId)) return;
    // Join BEFORE registering the runtime: if the join fails, the dedupe
    // guard above must not block the Session Manager's retry, or the session
    // would be orphaned (no bot, no timer, never finalized).
    await this.bot.join(note.roomId);
    const runtime = new SessionRuntime(
      note.sessionId,
      note.roomId,
      note.condition,
      note.durationMinutes,
      this.bot,
    );
    this.runtimes.set(note.roomId, runtime);
    this.log.log(
      `managing session ${note.sessionId} in ${note.roomId} (${note.condition.name})`,
    );
    // Server-side discussion timer: finalise when time is up.
    setTimeout(
      () => void this.endSession(note.roomId),
      note.durationMinutes * 60_000,
    );
  }

  private handleEvent(event: TimelineEvent): void {
    const runtime = this.runtimes.get(event.roomId);
    if (!runtime || runtime.isEnded) return;
    if (event.sender === this.bot.botUserId) return; // ignore our own events

    switch (event.type) {
      case "m.room.message": {
        const body =
          typeof event.content.body === "string" ? event.content.body : "";
        const message: Message = {
          id: event.eventId,
          timestamp: new Date(event.ts).toISOString(),
          senderId: event.sender,
          recipientId: null,
          text: body,
          reactions: [],
        };
        runtime.recordMessage(message);
        break;
      }
      case "m.reaction": {
        const rel = event.content["m.relates_to"] as
          | { rel_type?: string; event_id?: string; key?: string }
          | undefined;
        if (rel?.rel_type === "m.annotation" && rel.event_id && rel.key) {
          const reaction: Reaction = {
            key: rel.key,
            senderId: event.sender,
            timestamp: new Date(event.ts).toISOString(),
          };
          runtime.addReaction(event.eventId, rel.event_id, reaction);
        }
        break;
      }
      case "m.room.redaction": {
        if (event.redacts) runtime.removeRedacted(event.redacts);
        break;
      }
      case MATRIX_EVENT_TYPES.ranking: {
        const order = event.content.order;
        if (Array.isArray(order)) {
          runtime.recordRanking(event.content as unknown as Ranking);
        }
        break;
      }
    }

    // Hand off to the (teammate-implemented) rules, serialized per room.
    const chain = this.ruleChains.get(event.roomId) ?? Promise.resolve();
    this.ruleChains.set(
      event.roomId,
      chain
        .then(() => this.rules.onEvent(runtime, event))
        .catch((err) => this.log.error(`rules failed: ${String(err)}`)),
    );
  }

  /** Finalise: send the collected discussion back to the Session Manager. */
  async endSession(roomId: string): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.isEnded) return;
    runtime.markEnded();
    this.log.log(
      `finalizing session ${runtime.sessionId} ` +
        `(${runtime.messages.length} messages, ${runtime.rankingHistory.length} ranking edits)`,
    );
    try {
      await fetch(
        `${this.sessionManagerUrl}/sessions/${runtime.sessionId}/finalize`,
        {
          method: "POST",
          headers: internalHeaders(),
          body: JSON.stringify({
            messages: runtime.messages,
            rankingHistory: runtime.rankingHistory,
            interventions: runtime.interventions,
          }),
        },
      );
    } catch (err) {
      this.log.error(`finalize failed: ${String(err)}`);
    }
    this.runtimes.delete(roomId);
    this.ruleChains.delete(roomId);
  }
}

/** Headers for service-to-service calls (shared INTERNAL_API_TOKEN, if set). */
function internalHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-internal-token": token } : {}),
  };
}
