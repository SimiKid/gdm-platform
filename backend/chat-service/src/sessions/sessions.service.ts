import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { MATRIX_EVENT_TYPES, isServiceUser } from "@gdm/shared";
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
export class SessionsService implements OnModuleInit {
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
  private readonly checkpointTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly checkpointRequests = new Map<string, Promise<void>>();
  private readonly finalizingRooms = new Set<string>();

  constructor(
    private readonly bot: MatrixBotService,
    @Inject(BOT_RULES) private readonly rules: BotRules,
  ) {
    this.bot.onTimelineEvent((event) => this.handleEvent(event));
  }

  async onModuleInit(): Promise<void> {
    await this.bot.ensureReady();
    await this.recoverSessions();
    this.bot.start();
  }

  /** Take over a freshly-provisioned session. */
  async startSession(note: StartSessionNotification): Promise<void> {
    if (this.runtimes.has(note.roomId)) return;
    // Join BEFORE registering the runtime: if the join fails, the dedupe
    // guard above must not block the Session Manager's retry, or the session
    // would be orphaned (no bot, no timer, never finalized).
    await this.bot.join(note.roomId);
    if (note.condition.config.comparisonMode === true) {
      // Two-bot comparison test: Assistant A (rule-based) and Assistant B
      // (rule-based + LLM) join alongside the primary sync bot. The Session
      // Manager invited them during provisioning (study rooms are
      // invite-only). Never let their failure kill the takeover — recording
      // and the timer matter more than the extra bots.
      try {
        await this.bot.joinAs("a", note.roomId);
        await this.bot.joinAs("b", note.roomId);
      } catch (err) {
        this.log.error(
          `comparison bots could not join ${note.roomId} — continuing without them: ${String(err)}`,
        );
      }
    }
    const runtime = new SessionRuntime(
      note.sessionId,
      note.roomId,
      note.condition,
      note.durationMinutes,
      this.bot,
      note.startedAt,
      note.checkpoint,
    );
    this.runtimes.set(note.roomId, runtime);
    this.log.log(
      `managing session ${note.sessionId} in ${note.roomId} (${note.condition.name})`,
    );
    // Server-side discussion timer: finalise when time is up.
    const elapsed = note.startedAt
      ? Math.max(0, Date.now() - new Date(note.startedAt).getTime())
      : 0;
    const remaining = Math.max(
      note.checkpoint ? 5000 : 0,
      note.durationMinutes * 60_000 - elapsed,
    );
    setTimeout(() => void this.endSession(note.roomId), remaining);
  }

  private handleEvent(event: TimelineEvent): void {
    const runtime = this.runtimes.get(event.roomId);
    if (!runtime || runtime.isEnded || this.finalizingRooms.has(event.roomId)) {
      return;
    }
    if (event.sender === this.bot.botUserId || isServiceUser(event.sender)) return;
    if (runtime.hasProcessed(event.eventId)) return;
    runtime.markProcessed(event.eventId);

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
          const ranking = event.content as unknown as Ranking;
          runtime.recordRanking(ranking);
          if (ranking.movement) {
            runtime.recordBehavior({
              id: `ranking-move:${event.eventId}`,
              type: "ranking-move",
              participantId: event.sender,
              timestamp: new Date(event.ts).toISOString(),
              payload: {
                itemId: ranking.movement.itemId,
                from: ranking.movement.from,
                to: ranking.movement.to,
              },
            });
          }
        }
        break;
      }
      case MATRIX_EVENT_TYPES.behavior: {
        const type = event.content.type;
        if (
          type === "typing-start" ||
          type === "typing-stop" ||
          type === "tab-hidden" ||
          type === "tab-visible" ||
          type === "cursor-activity"
        ) {
          runtime.recordBehavior({
            id: event.eventId,
            type,
            participantId: event.sender,
            timestamp: new Date(event.ts).toISOString(),
            durationMs:
              typeof event.content.durationMs === "number"
                ? event.content.durationMs
                : undefined,
            payload:
              type === "cursor-activity"
                ? {
                    sampleCount: Number(event.content.sampleCount ?? 0),
                    distancePx: Number(event.content.distancePx ?? 0),
                    lastX: Number(event.content.lastX ?? 0),
                    lastY: Number(event.content.lastY ?? 0),
                  }
                : undefined,
          });
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
        .catch((err) => this.log.error(`rules failed: ${String(err)}`))
        .finally(() => this.scheduleCheckpoint(runtime)),
    );
  }

  /** Finalise: send the collected discussion back to the Session Manager. */
  async endSession(roomId: string): Promise<void> {
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.isEnded || this.finalizingRooms.has(roomId)) return;
    this.finalizingRooms.add(roomId);
    await this.ruleChains.get(roomId);
    const timer = this.checkpointTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.checkpointTimers.delete(roomId);
    await this.checkpointRequests.get(roomId);
    this.log.log(
      `finalizing session ${runtime.sessionId} ` +
        `(${runtime.messages.length} messages, ${runtime.rankingHistory.length} ranking edits)`,
    );
    try {
      const res = await fetch(
        `${this.sessionManagerUrl}/sessions/${runtime.sessionId}/finalize`,
        {
          method: "POST",
          headers: internalHeaders(),
          body: JSON.stringify(runtime.checkpoint()),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      this.log.error(`finalize failed: ${String(err)}`);
      this.finalizingRooms.delete(roomId);
      setTimeout(() => void this.endSession(roomId), 5000);
      return;
    }
    runtime.markEnded();
    this.runtimes.delete(roomId);
    this.ruleChains.delete(roomId);
    this.checkpointRequests.delete(roomId);
    this.finalizingRooms.delete(roomId);
  }

  private scheduleCheckpoint(runtime: SessionRuntime): void {
    if (this.finalizingRooms.has(runtime.roomId)) return;
    const existing = this.checkpointTimers.get(runtime.roomId);
    if (existing) clearTimeout(existing);
    this.checkpointTimers.set(
      runtime.roomId,
      setTimeout(() => {
        const request = this.persistCheckpoint(runtime).finally(() => {
          if (this.checkpointRequests.get(runtime.roomId) === request) {
            this.checkpointRequests.delete(runtime.roomId);
          }
        });
        this.checkpointRequests.set(runtime.roomId, request);
      }, 1000),
    );
  }

  private async persistCheckpoint(runtime: SessionRuntime): Promise<void> {
    this.checkpointTimers.delete(runtime.roomId);
    if (runtime.isEnded) return;
    try {
      const res = await fetch(
        `${this.sessionManagerUrl}/sessions/${runtime.sessionId}/checkpoint`,
        {
          method: "PUT",
          headers: internalHeaders(),
          body: JSON.stringify(runtime.checkpoint()),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      this.log.error(`checkpoint failed: ${String(err)}`);
      if (!this.finalizingRooms.has(runtime.roomId)) {
        this.scheduleCheckpoint(runtime);
      }
    }
  }

  private async recoverSessions(): Promise<void> {
    try {
      const res = await fetch(`${this.sessionManagerUrl}/sessions/recover`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          botUserId: this.bot.botUserId,
          comparisonBotUserIds: await this.bot.comparisonBotUserIds(),
        }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const notes = (await res.json()) as StartSessionNotification[];
      for (const note of notes) await this.startSession(note);
      if (notes.length > 0) {
        this.log.log(`recovered ${notes.length} live session(s)`);
      }
    } catch (err) {
      this.log.warn(`session recovery unavailable: ${String(err)}`);
    }
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
