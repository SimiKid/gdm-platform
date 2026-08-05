import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";

/** A normalised timeline event handed to the session runtime / rules. */
export interface TimelineEvent {
  roomId: string;
  type: string;
  sender: string;
  eventId: string;
  ts: number;
  content: Record<string, unknown>;
  /** For m.room.redaction: the id of the event being redacted. */
  redacts?: string;
}

type EventHandler = (event: TimelineEvent) => void;

/** The two comparison-mode bots: "a" = rule-based, "b" = rule + LLM. */
export const COMPARISON_BOT_KINDS = ["a", "b"] as const;

/**
 * The Chat Service's Matrix presence: a single bot user that joins every
 * managed room and tails the /sync stream. Open registration is enabled on the
 * dev homeserver, so no appservice registration is needed for this skeleton.
 *
 * (A production version would register a proper application service via the
 * homeserver.yaml stubs, but this bot-user approach is enough to run rules.)
 */
@Injectable()
export class MatrixBotService implements OnModuleInit {
  private readonly log = new Logger(MatrixBotService.name);
  private readonly internalUrl =
    process.env.MATRIX_INTERNAL_URL ?? "http://localhost:8008";
  private userId = "";
  private accessToken = "";
  private running = false;
  private registration?: Promise<void>;
  private syncAbort?: AbortController;
  private readonly handlers: EventHandler[] = [];
  private readonly rateLimitRetries = nonNegativeInt(
    process.env.MATRIX_RATE_LIMIT_RETRIES,
    8,
  );
  private readonly maxRetryDelayMs = nonNegativeInt(
    process.env.MATRIX_RETRY_MAX_DELAY_MS,
    30_000,
  );
  private readonly requestTimeoutMs = positiveInt(
    process.env.MATRIX_REQUEST_TIMEOUT_MS,
    15_000,
  );
  private readonly syncRequestTimeoutMs = positiveInt(
    process.env.MATRIX_SYNC_REQUEST_TIMEOUT_MS,
    40_000,
  );
  /**
   * Named secondary bot identities for the two-bot comparison mode
   * (e.g. "a" → gdm_bot_a_<suffix>). They only join and send — the primary
   * bot's /sync stream observes the room for all of them.
   */
  private readonly identities = new Map<
    string,
    Promise<{ userId: string; accessToken: string }>
  >();

  async onModuleInit(): Promise<void> {
    await this.ensureReady();
  }

  async ensureReady(): Promise<void> {
    this.registration ??= this.register();
    await this.registration;
  }

  get botUserId(): string {
    return this.userId;
  }

  /**
   * Matrix user ids of the comparison bots, registering them on first use.
   * The Session Manager needs these to invite them into the invite-only
   * study rooms before the bots can join.
   */
  async comparisonBotUserIds(): Promise<string[]> {
    const identities = await Promise.all(
      COMPARISON_BOT_KINDS.map((kind) => this.ensureIdentity(kind)),
    );
    return identities.map((identity) => identity.userId);
  }

  /** Subscribe to every timeline event across all joined rooms. */
  onTimelineEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Accept the Session Manager's invitation and join a study room by id. */
  async join(roomId: string): Promise<void> {
    await this.joinWith(this.accessToken, roomId);
  }

  /** Join a room as a named secondary identity (registered on first use). */
  async joinAs(kind: string, roomId: string): Promise<void> {
    const identity = await this.ensureIdentity(kind);
    await this.joinWith(identity.accessToken, roomId);
  }

  /**
   * Post a message as a named secondary identity. `extraContent` is merged
   * into the event content — e.g. the recipient key for a private nudge.
   */
  async sendTextAs(
    kind: string,
    roomId: string,
    body: string,
    extraContent: Record<string, unknown> = {},
  ): Promise<void> {
    const identity = await this.ensureIdentity(kind);
    await this.sendWith(identity.accessToken, roomId, body, extraContent);
  }

  /**
   * Post a plain-text message into a room (used by rules for nudges).
   * `extraContent` is merged into the event content — e.g. the recipient key
   * for a private nudge.
   */
  async sendText(
    roomId: string,
    body: string,
    extraContent: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sendWith(this.accessToken, roomId, body, extraContent);
  }

  /** Redact (delete) a message from a room. Requires sufficient power level. */
  async redact(roomId: string, eventId: string, reason?: string): Promise<void> {
    const txn = `r${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(
      `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
        roomId,
      )}/redact/${encodeURIComponent(eventId)}/${txn}`,
      {
        method: "PUT",
        headers: this.authHeaders(),
        body: JSON.stringify(reason ? { reason } : {}),
      },
    );
    if (!res.ok) throw new Error(`bot redact failed (${res.status})`);
  }

  async getJoinedMemberIds(roomId: string): Promise<string[]> {
    const res = await this.fetchWithRateLimitRetry("joined_members", () =>
      fetch(
        `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
          roomId,
        )}/joined_members`,
        {
          headers: this.authHeaders(),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ),
    );
    if (!res.ok) throw new Error(`joined_members failed (${res.status})`);
    const data = (await res.json()) as {
      joined?: Record<string, unknown>;
    };
    return Object.keys(data.joined ?? {});
  }

  /**
   * Read the complete room timeline for a running study, newest pages first
   * from Synapse and returned oldest-to-newest for deterministic replay.
   * Checkpoint event ids make replay idempotent; this closes the gap between
   * the last committed checkpoint and an abrupt Chat Service restart.
   */
  async roomHistory(roomId: string, startedAtMs: number): Promise<TimelineEvent[]> {
    const newestFirst: TimelineEvent[] = [];
    const seen = new Set<string>();
    let from: string | undefined;

    // A ten-minute study cannot legitimately approach 100,000 timeline
    // events. Throw instead of silently truncating if Synapse behaves badly.
    for (let page = 0; page < 1000; page += 1) {
      const query = new URLSearchParams({ dir: "b", limit: "100" });
      if (from) query.set("from", from);
      const res = await this.fetchWithRateLimitRetry("room history", () =>
        fetch(
          `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
            roomId,
          )}/messages?${query.toString()}`,
          {
            headers: this.authHeaders(),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          },
        ),
      );
      if (!res.ok) throw new Error(`room history failed (${res.status})`);
      const data = (await res.json()) as {
        chunk?: SyncRoomEvent[];
        end?: string;
      };
      const chunk = data.chunk ?? [];
      let reachedSessionStart = false;
      for (const raw of chunk) {
        if (raw.origin_server_ts < startedAtMs) {
          reachedSessionStart = true;
          continue;
        }
        if (seen.has(raw.event_id)) continue;
        seen.add(raw.event_id);
        newestFirst.push(toTimelineEvent(roomId, raw));
      }

      if (reachedSessionStart || chunk.length === 0 || !data.end) {
        return newestFirst.reverse();
      }
      if (data.end === from) throw new Error("room history pagination stalled");
      from = data.end;
    }
    throw new Error("room history exceeded 100000 events");
  }

  stop(): void {
    this.running = false;
    this.syncAbort?.abort();
  }

  /** Start syncing after live runtimes have been recovered and handlers exist. */
  start(): void {
    if (!this.running) void this.startSync();
  }

  // ── internals ──────────────────────────────────────────────────

  private authHeaders(token: string = this.accessToken): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
  }

  private async joinWith(token: string, roomId: string): Promise<void> {
    const res = await this.fetchWithRateLimitRetry("bot join", () =>
      fetch(
        `${this.internalUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
        {
          method: "POST",
          headers: this.authHeaders(token),
          body: "{}",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      ),
    );
    if (!res.ok) throw new Error(`bot join failed (${res.status})`);
  }

  private async sendWith(
    token: string,
    roomId: string,
    body: string,
    extraContent: Record<string, unknown>,
  ): Promise<void> {
    // Reuse the transaction id for every rate-limit retry. Matrix therefore
    // cannot create duplicate bot messages from the same logical send.
    const txn = `m${randomUUID()}`;
    const url = `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
      roomId,
    )}/send/m.room.message/${txn}`;
    const res = await this.fetchWithRateLimitRetry("bot send", () =>
      fetch(url, {
        method: "PUT",
        headers: this.authHeaders(token),
        body: JSON.stringify({ msgtype: "m.text", body, ...extraContent }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (!res.ok) throw new Error(`bot send failed (${res.status})`);
  }

  private ensureIdentity(
    kind: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const existing = this.identities.get(kind);
    if (existing) return existing;
    const created = this.registerUser(`gdm_bot_${kind}_`)
      .then((identity) => {
        this.log.log(`comparison bot "${kind}" user ${identity.userId}`);
        return identity;
      })
      .catch((error: unknown) => {
        // Do not cache a transient failure for the lifetime of the process.
        // The next provisioning attempt can register the identity again.
        if (this.identities.get(kind) === created) this.identities.delete(kind);
        throw error;
      });
    this.identities.set(kind, created);
    return created;
  }

  private async register(): Promise<void> {
    const identity = await this.registerUser("gdm_bot_");
    this.userId = identity.userId;
    this.accessToken = identity.accessToken;
    this.log.log(`bot user ${this.userId}`);
  }

  private async registerUser(
    usernamePrefix: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const res = await this.fetchWithRateLimitRetry("bot register", () =>
      fetch(`${this.internalUrl}/_matrix/client/v3/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: `${usernamePrefix}${suffix}`,
          password: `${randomBytes(24).toString("base64url")}Aa1!`,
          auth: { type: "m.login.dummy" },
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      }),
    );
    if (!res.ok) throw new Error(`bot register failed (${res.status})`);
    const data = (await res.json()) as { user_id: string; access_token: string };
    return { userId: data.user_id, accessToken: data.access_token };
  }

  /** Initial sync includes recent room history so restart gaps can be replayed. */
  private async startSync(): Promise<void> {
    this.running = true;
    await this.loop();
  }

  private async loop(since?: string): Promise<void> {
    while (this.running) {
      const controller = new AbortController();
      this.syncAbort = controller;
      try {
        const url =
          `${this.internalUrl}/_matrix/client/v3/sync?timeout=30000` +
          (since ? `&since=${encodeURIComponent(since)}` : "");
        const res = await fetch(url, {
          headers: this.authHeaders(),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(this.syncRequestTimeoutMs),
          ]),
        });
        if (!res.ok) {
          if (this.running) await this.delay(2000);
          continue;
        }
        const data = (await res.json()) as SyncResponse;
        since = data.next_batch;
        const joined = data.rooms?.join ?? {};
        for (const roomId of Object.keys(joined)) {
          for (const ev of joined[roomId].timeline?.events ?? []) {
            const event = toTimelineEvent(roomId, ev);
            for (const handler of this.handlers) handler(event);
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.log.error(`sync error: ${String(err)}`);
        await this.delay(2000);
      } finally {
        if (this.syncAbort === controller) this.syncAbort = undefined;
      }
    }
  }

  /** Respect Synapse's retry hint while keeping retries and delay bounded. */
  private async fetchWithRateLimitRetry(
    operation: string,
    request: () => Promise<Response>,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await request();
      if (response.status !== 429 || attempt >= this.rateLimitRetries) {
        return response;
      }
      const hintedDelayMs = Math.min(
        this.maxRetryDelayMs,
        await matrixRetryAfterMs(response),
      );
      // Positive jitter keeps a burst from waking and being throttled again as
      // one synchronized wave.
      const retryAfterMs = Math.min(
        this.maxRetryDelayMs,
        hintedDelayMs +
          Math.floor(Math.random() * Math.min(1000, hintedDelayMs / 4)),
      );
      this.log.warn(
        `${operation} rate-limited; retrying in ${retryAfterMs}ms ` +
          `(${attempt + 1}/${this.rateLimitRetries})`,
      );
      await this.delay(retryAfterMs);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function matrixRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers?.get?.("retry-after");
  const headerSeconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.max(1, Math.round(headerSeconds * 1000));
  }
  try {
    const body = (await response.clone().json()) as { retry_after_ms?: unknown };
    const value = Number(body.retry_after_ms);
    if (Number.isFinite(value) && value >= 0) return Math.max(1, Math.round(value));
  } catch {
    // Plain test doubles and malformed 429 responses use a safe fallback.
  }
  return 1000;
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toTimelineEvent(roomId: string, ev: SyncRoomEvent): TimelineEvent {
  return {
    roomId,
    type: ev.type,
    sender: ev.sender,
    eventId: ev.event_id,
    ts: ev.origin_server_ts,
    content: ev.content ?? {},
    redacts:
      ev.redacts ??
      (typeof ev.content?.redacts === "string"
        ? ev.content.redacts
        : undefined),
  };
}

interface SyncRoomEvent {
  type: string;
  sender: string;
  event_id: string;
  origin_server_ts: number;
  content?: Record<string, unknown>;
  redacts?: string;
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: SyncRoomEvent[] } }>;
  };
}
