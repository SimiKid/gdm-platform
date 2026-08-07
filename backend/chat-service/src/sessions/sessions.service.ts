import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from "@nestjs/common";
import {
  DEFAULT_INTERVENTION_CONFIG,
  GDM_RECIPIENT_KEY,
  MATRIX_EVENT_TYPES,
  isServiceUser,
} from "@gdm/shared";
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
import { ModerationClassifier } from "../classifier/moderation-classifier";

/**
 * Owns the live sessions the Chat Service is running. Started by the Session
 * Manager (POST /internal/sessions/start), it joins the room, tails the stream
 * into a SessionRuntime, runs the rules, and finalises the data back to the
 * Session Manager when the discussion timer ends.
 */
@Injectable()
export class SessionsService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly log = new Logger(SessionsService.name);
  private readonly sessionManagerUrl =
    process.env.SESSION_MANAGER_URL ?? "http://localhost:3001/api";
  /** roomId -> live runtime. */
  private readonly runtimes = new Map<string, SessionRuntime>();
  /**
   * In-flight per-message rule work. LLM classification is intentionally not
   * serialized: a burst must not create a network-call queue that delays the
   * contribution-window timer.
   */
  private readonly ruleRequests = new Map<string, Set<Promise<void>>>();
  /** Window evaluations remain serialized with other window evaluations. */
  private readonly windowRequests = new Map<string, Promise<void>>();
  private readonly checkpointTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** roomId -> timer for the next contribution-window boundary. */
  private readonly windowTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly checkpointRequests = new Map<string, Promise<void>>();
  /** Rooms changed while a checkpoint was queued/in flight. */
  private readonly checkpointDirty = new Set<string>();
  private readonly finalizingRooms = new Set<string>();
  private readonly startRequests = new Map<string, Promise<void>>();
  /** Events arriving in the short join/backfill window before runtime install. */
  private readonly pendingEvents = new Map<
    string,
    Map<string, TimelineEvent>
  >();
  private readonly retiredRooms = new Set<string>();
  private readonly sessionEndTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly comparisonJoinTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private recoveryRequest?: Promise<void>;
  private shuttingDown = false;
  private readonly checkpointTimeoutMs = positiveInt(
    process.env.CHECKPOINT_TIMEOUT_MS,
    30_000,
  );

  constructor(
    private readonly bot: MatrixBotService,
    @Inject(BOT_RULES) private readonly rules: BotRules,
    private readonly moderation: ModerationClassifier,
  ) {
    this.bot.onTimelineEvent((event) => this.handleEvent(event));
  }

  async onModuleInit(): Promise<void> {
    await this.bot.ensureReady();
    await this.recoverSessions();
    this.bot.start();
  }

  /** Flush the latest runtime state before Docker replaces the service. */
  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.bot.stop();
    for (const timer of this.checkpointTimers.values()) clearTimeout(timer);
    for (const timer of this.windowTimers.values()) clearTimeout(timer);
    for (const timer of this.sessionEndTimers.values()) clearTimeout(timer);
    for (const timer of this.comparisonJoinTimers.values()) clearTimeout(timer);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.checkpointTimers.clear();
    this.windowTimers.clear();
    this.sessionEndTimers.clear();
    this.comparisonJoinTimers.clear();

    const ruleWork = [...this.ruleRequests.values()].flatMap((requests) => [
      ...requests,
    ]);
    await Promise.allSettled([
      ...ruleWork,
      ...this.windowRequests.values(),
      ...this.checkpointRequests.values(),
    ]);
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => !runtime.isEnded)
        .map((runtime) => this.persistCheckpoint(runtime)),
    );
    this.log.log(`shutdown checkpointed ${this.runtimes.size} live session(s)`);
  }

  /** Take over a freshly-provisioned session. */
  async startSession(note: StartSessionNotification): Promise<void> {
    if (this.runtimes.has(note.roomId)) return;
    const existing = this.startRequests.get(note.roomId);
    if (existing) return existing;
    const request = this.doStartSession(note).finally(() => {
      if (this.startRequests.get(note.roomId) === request) {
        this.startRequests.delete(note.roomId);
      }
    });
    this.startRequests.set(note.roomId, request);
    return request;
  }

  private async doStartSession(note: StartSessionNotification): Promise<void> {
    if (this.shuttingDown) throw new Error("Chat Service is shutting down");
    // Join BEFORE registering the runtime: if the join fails, the dedupe
    // guard above must not block the Session Manager's retry, or the session
    // would be orphaned (no bot, no timer, never finalized).
    await this.bot.join(note.roomId);
    let comparisonJoinFailed = false;
    if (note.condition.config.comparisonMode === true) {
      // Two-bot comparison test: Assistant A (rule-based) and Assistant B
      // (rule-based + LLM) join alongside the primary sync bot. The Session
      // Manager invited them during provisioning (study rooms are
      // invite-only). Never let their failure kill the takeover — recording
      // and the timer matter more than the extra bots.
      for (const kind of ["a", "b"] as const) {
        try {
          await this.bot.joinAs(kind, note.roomId);
        } catch (err) {
          comparisonJoinFailed = true;
          this.log.error(
            `comparison bot ${kind} could not join ${note.roomId}: ${String(err)}`,
          );
        }
      }
    }
    const startedAtMs = note.startedAt
      ? new Date(note.startedAt).getTime()
      : Date.now();
    const history =
      note.checkpoint && Number.isFinite(startedAtMs)
        ? await this.bot.roomHistory(note.roomId, startedAtMs)
        : [];
    if (this.shuttingDown) throw new Error("Chat Service is shutting down");
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
    this.retiredRooms.delete(note.roomId);
    const pending = [
      ...(this.pendingEvents.get(note.roomId)?.values() ?? []),
    ];
    this.pendingEvents.delete(note.roomId);
    const replayed = new Set<string>();
    for (const event of [...history, ...pending]) {
      if (replayed.has(event.eventId)) continue;
      replayed.add(event.eventId);
      this.handleEvent(event);
    }
    if (comparisonJoinFailed) this.scheduleComparisonJoinRetry(note.roomId);
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
    this.sessionEndTimers.set(
      note.roomId,
      setTimeout(() => void this.endSession(note.roomId), remaining),
    );
    // The bot nudges at window boundaries, not on messages. Aligned to
    // startedAt, so a restart resumes the same window grid.
    this.scheduleWindowTick(runtime);
  }

  private scheduleWindowTick(runtime: SessionRuntime): void {
    const config = runtime.condition.config;
    const windowMs =
      (config.contributionWindowMinutes ??
        DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes) * 60_000;
    if (!(windowMs > 0)) return;
    // The grid starts when the warm-up ends: people arriving during the
    // protected start are neither counted nor nudged, and the first window
    // closes one window length after the warm-up.
    const warmupMs = Math.max(
      0,
      (config.protectedStartMinutes ??
        DEFAULT_INTERVENTION_CONFIG.protectedStartMinutes) * 60_000,
    );
    const gridStartMs = runtime.startedAtMs + warmupMs;
    const now = Date.now();
    const elapsed = Math.max(0, now - gridStartMs);
    const nextBoundary =
      gridStartMs + (Math.floor(elapsed / windowMs) + 1) * windowMs;
    this.windowTimers.set(
      runtime.roomId,
      setTimeout(() => this.onWindowBoundary(runtime, nextBoundary), nextBoundary - now),
    );
  }

  private onWindowBoundary(runtime: SessionRuntime, windowEndMs: number): void {
    this.windowTimers.delete(runtime.roomId);
    if (
      this.shuttingDown ||
      runtime.isEnded ||
      this.finalizingRooms.has(runtime.roomId) ||
      this.runtimes.get(runtime.roomId) !== runtime
    ) {
      return;
    }
    const previous = this.windowRequests.get(runtime.roomId) ?? Promise.resolve();
    const request = previous
      .then(() => this.rules.onWindowElapsed?.(runtime, windowEndMs))
      .catch((err) => this.log.error(`window rules failed: ${String(err)}`))
      .finally(() => {
        if (this.windowRequests.get(runtime.roomId) === request) {
          this.windowRequests.delete(runtime.roomId);
        }
        this.scheduleCheckpoint(runtime);
      });
    this.windowRequests.set(
      runtime.roomId,
      request,
    );
    this.scheduleWindowTick(runtime);
  }

  private handleEvent(event: TimelineEvent): void {
    const runtime = this.runtimes.get(event.roomId);
    if (!runtime) {
      if (!this.shuttingDown && !this.retiredRooms.has(event.roomId)) {
        const pending = this.pendingEvents.get(event.roomId) ?? new Map();
        pending.set(event.eventId, event);
        this.pendingEvents.set(event.roomId, pending);
      }
      return;
    }
    if (
      this.shuttingDown ||
      runtime.isEnded ||
      this.finalizingRooms.has(event.roomId)
    ) {
      return;
    }
    if (event.sender === this.bot.botUserId || isServiceUser(event.sender)) {
      // Bot messages belong in the research record (docs/data-export.md
      // promises recipientId for private nudges), but rules and the
      // classifier must never run on them, and they never count toward
      // contribution scores. Recording off the bot's own sync echo keeps the
      // real Matrix event id/timestamp and covers comparison bots A/B too.
      if (
        event.type === "m.room.message" &&
        !runtime.hasProcessed(event.eventId)
      ) {
        runtime.markProcessed(event.eventId);
        const recipient = event.content[GDM_RECIPIENT_KEY];
        runtime.recordMessage({
          id: event.eventId,
          timestamp: new Date(event.ts).toISOString(),
          senderId: event.sender,
          recipientId: typeof recipient === "string" ? recipient : null,
          text: typeof event.content.body === "string" ? event.content.body : "",
          reactions: [],
        });
        this.scheduleCheckpoint(runtime);
      }
      return;
    }
    if (runtime.hasProcessed(event.eventId)) {
      // History replay is also how checkpoints created before reactions had
      // stable event ids rebuild their redaction index. Do not rerun rules or
      // duplicate data; only restore reaction/tombstone metadata.
      if (event.type === "m.reaction") {
        this.applyReaction(runtime, event);
      } else if (event.type === "m.room.redaction" && event.redacts) {
        runtime.removeRedacted(
          event.redacts,
          event.eventId,
          new Date(event.ts).toISOString(),
        );
      }
      return;
    }
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
        this.applyReaction(runtime, event);
        break;
      }
      case "m.room.redaction": {
        if (event.redacts) {
          runtime.removeRedacted(
            event.redacts,
            event.eventId,
            new Date(event.ts).toISOString(),
          );
        }
        break;
      }
      case MATRIX_EVENT_TYPES.ranking: {
        const order = event.content.order;
        if (Array.isArray(order)) {
          const ranking = {
            ...(event.content as unknown as Ranking),
            eventId: event.eventId,
          };
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

    // Moderation: check participant messages for abusive content. Runs
    // concurrently — if flagged the message is redacted and a private
    // warning is sent. Fail-open: API errors never block messages.
    if (event.type === "m.room.message") {
      const body =
        typeof event.content.body === "string" ? event.content.body : "";
      if (body) {
        this.moderation
          .check(body)
          .then(async (result) => {
            if (!result.flagged) return;
            this.log.warn(
              `moderation flagged message ${event.eventId} from ${event.sender}: ${result.reason}`,
            );
            try {
              await this.bot.redact(event.roomId, event.eventId, "moderation");
              await this.bot.sendText(event.roomId, "Your message was removed because it violates the study's conduct policy. Please keep the discussion respectful.", {
                [GDM_RECIPIENT_KEY]: event.sender,
              });
            } catch (err) {
              this.log.error(`moderation redact/warn failed: ${String(err)}`);
            }
          })
          .catch((err) => this.log.error(`moderation failed: ${String(err)}`));
      }
    }

    // Start rule work immediately. In particular, independent Anthropic
    // classifications run concurrently instead of blocking later events or
    // the fixed window boundary.
    const requests = this.ruleRequests.get(event.roomId) ?? new Set<Promise<void>>();
    this.ruleRequests.set(event.roomId, requests);
    const request = Promise.resolve()
      .then(() => this.rules.onEvent(runtime, event))
      .catch((err) => this.log.error(`rules failed: ${String(err)}`))
      .finally(() => {
        requests.delete(request);
        if (requests.size === 0) this.ruleRequests.delete(event.roomId);
        this.scheduleCheckpoint(runtime);
      });
    requests.add(request);
  }

  private applyReaction(runtime: SessionRuntime, event: TimelineEvent): void {
    const rel = event.content["m.relates_to"] as
      | { rel_type?: string; event_id?: string; key?: string }
      | undefined;
    if (rel?.rel_type !== "m.annotation" || !rel.event_id || !rel.key) return;
    const reaction: Reaction = {
      eventId: event.eventId,
      key: rel.key,
      senderId: event.sender,
      timestamp: new Date(event.ts).toISOString(),
    };
    runtime.addReaction(event.eventId, rel.event_id, reaction);
  }

  /** Finalise: send the collected discussion back to the Session Manager. */
  async endSession(roomId: string): Promise<void> {
    if (this.shuttingDown) return;
    const endTimer = this.sessionEndTimers.get(roomId);
    if (endTimer) clearTimeout(endTimer);
    this.sessionEndTimers.delete(roomId);
    const runtime = this.runtimes.get(roomId);
    if (!runtime || runtime.isEnded || this.finalizingRooms.has(roomId)) return;
    this.finalizingRooms.add(roomId);
    const windowTimer = this.windowTimers.get(roomId);
    if (windowTimer) clearTimeout(windowTimer);
    this.windowTimers.delete(roomId);
    await this.windowRequests.get(roomId);
    await Promise.allSettled(this.ruleRequests.get(roomId) ?? []);
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
          signal: AbortSignal.timeout(this.checkpointTimeoutMs),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      this.log.error(`finalize failed: ${String(err)}`);
      this.finalizingRooms.delete(roomId);
      this.sessionEndTimers.set(
        roomId,
        setTimeout(() => void this.endSession(roomId), 5000),
      );
      return;
    }
    runtime.markEnded();
    this.runtimes.delete(roomId);
    this.retiredRooms.add(roomId);
    this.pendingEvents.delete(roomId);
    const comparisonTimer = this.comparisonJoinTimers.get(roomId);
    if (comparisonTimer) clearTimeout(comparisonTimer);
    this.comparisonJoinTimers.delete(roomId);
    this.ruleRequests.delete(roomId);
    this.windowRequests.delete(roomId);
    this.checkpointRequests.delete(roomId);
    this.checkpointDirty.delete(roomId);
    this.finalizingRooms.delete(roomId);
  }

  private scheduleCheckpoint(runtime: SessionRuntime): void {
    if (this.shuttingDown || this.finalizingRooms.has(runtime.roomId)) return;
    this.checkpointDirty.add(runtime.roomId);
    // Never overlap full snapshots for one session. Events arriving while a
    // write is in flight merely mark the room dirty; one latest-state write
    // follows after the current request finishes.
    if (
      this.checkpointRequests.has(runtime.roomId) ||
      this.checkpointTimers.has(runtime.roomId)
    ) {
      return;
    }
    this.checkpointTimers.set(
      runtime.roomId,
      setTimeout(() => this.flushCheckpoint(runtime), 1000),
    );
  }

  private flushCheckpoint(runtime: SessionRuntime): void {
    this.checkpointTimers.delete(runtime.roomId);
    if (
      this.shuttingDown ||
      runtime.isEnded ||
      this.finalizingRooms.has(runtime.roomId) ||
      !this.checkpointDirty.has(runtime.roomId)
    ) {
      return;
    }
    this.checkpointDirty.delete(runtime.roomId);
    const request = this.persistCheckpoint(runtime).finally(() => {
      if (this.checkpointRequests.get(runtime.roomId) === request) {
        this.checkpointRequests.delete(runtime.roomId);
      }
      if (
        this.checkpointDirty.has(runtime.roomId) &&
        !this.finalizingRooms.has(runtime.roomId)
      ) {
        this.scheduleCheckpoint(runtime);
      }
    });
    this.checkpointRequests.set(runtime.roomId, request);
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
          signal: AbortSignal.timeout(this.checkpointTimeoutMs),
        },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      this.log.error(`checkpoint failed: ${String(err)}`);
      if (!this.finalizingRooms.has(runtime.roomId)) {
        this.checkpointDirty.add(runtime.roomId);
      }
    }
  }

  private recoverSessions(): Promise<void> {
    if (this.recoveryRequest) return this.recoveryRequest;
    const request = this.doRecoverSessions().finally(() => {
      if (this.recoveryRequest === request) this.recoveryRequest = undefined;
    });
    this.recoveryRequest = request;
    return request;
  }

  private async doRecoverSessions(): Promise<void> {
    let retryNeeded = false;
    try {
      const res = await fetch(`${this.sessionManagerUrl}/sessions/recover`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({
          botUserId: this.bot.botUserId,
          comparisonBotUserIds: await this.bot.comparisonBotUserIds(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const notes = (await res.json()) as StartSessionNotification[];
      await forEachConcurrent(notes, 8, async (note) => {
        if (this.shuttingDown || this.runtimes.has(note.roomId)) return;
        try {
          await this.startSession(note);
        } catch (error) {
          retryNeeded = true;
          this.log.warn(
            `could not recover session ${note.sessionId}: ${String(error)}`,
          );
        }
      });
      if (notes.length > 0) {
        this.log.log(
          `recovered ${notes.filter((note) => this.runtimes.has(note.roomId)).length}` +
            `/${notes.length} live session(s)`,
        );
      }
    } catch (err) {
      retryNeeded = true;
      this.log.warn(`session recovery unavailable: ${String(err)}`);
    }
    if (retryNeeded) this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.shuttingDown || this.recoveryTimer) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recoverSessions();
    }, 5000);
  }

  private scheduleComparisonJoinRetry(roomId: string): void {
    if (this.shuttingDown || this.comparisonJoinTimers.has(roomId)) return;
    this.comparisonJoinTimers.set(
      roomId,
      setTimeout(async () => {
        this.comparisonJoinTimers.delete(roomId);
        const runtime = this.runtimes.get(roomId);
        if (
          this.shuttingDown ||
          !runtime ||
          runtime.isEnded ||
          runtime.condition.config.comparisonMode !== true
        ) {
          return;
        }
        const results = await Promise.allSettled([
          this.bot.joinAs("a", roomId),
          this.bot.joinAs("b", roomId),
        ]);
        if (results.some((result) => result.status === "rejected")) {
          this.log.warn(`comparison bot join retry failed for ${roomId}`);
          this.scheduleComparisonJoinRetry(roomId);
        }
      }, 5000),
    );
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(workers);
}

/** Headers for service-to-service calls (shared INTERNAL_API_TOKEN, if set). */
function internalHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-internal-token": token } : {}),
  };
}
