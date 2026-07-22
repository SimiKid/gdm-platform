import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

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
  private readonly handlers: EventHandler[] = [];
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

  /** Subscribe to every timeline event across all joined rooms. */
  onTimelineEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Join a room by id (rooms are public_chat, so join-by-id works). */
  async join(roomId: string): Promise<void> {
    await this.joinWith(this.accessToken, roomId);
  }

  /** Join a room as a named secondary identity (registered on first use). */
  async joinAs(kind: string, roomId: string): Promise<void> {
    const identity = await this.ensureIdentity(kind);
    await this.joinWith(identity.accessToken, roomId);
  }

  /**
   * Post a message as a named secondary identity. Comparison-mode nudges are
   * always public, so there is no private variant here.
   */
  async sendTextAs(kind: string, roomId: string, body: string): Promise<void> {
    const identity = await this.ensureIdentity(kind);
    await this.sendWith(identity.accessToken, roomId, body, {});
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

  async getJoinedMemberIds(roomId: string): Promise<string[]> {
    const res = await fetch(
      `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
        roomId,
      )}/joined_members`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw new Error(`joined_members failed (${res.status})`);
    const data = (await res.json()) as {
      joined?: Record<string, unknown>;
    };
    return Object.keys(data.joined ?? {});
  }

  stop(): void {
    this.running = false;
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
    const res = await fetch(
      `${this.internalUrl}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { method: "POST", headers: this.authHeaders(token), body: "{}" },
    );
    if (!res.ok) throw new Error(`bot join failed (${res.status})`);
  }

  private async sendWith(
    token: string,
    roomId: string,
    body: string,
    extraContent: Record<string, unknown>,
  ): Promise<void> {
    const txn = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(
      `${this.internalUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
        roomId,
      )}/send/m.room.message/${txn}`,
      {
        method: "PUT",
        headers: this.authHeaders(token),
        body: JSON.stringify({ msgtype: "m.text", body, ...extraContent }),
      },
    );
    if (!res.ok) throw new Error(`bot send failed (${res.status})`);
  }

  private ensureIdentity(
    kind: string,
  ): Promise<{ userId: string; accessToken: string }> {
    const existing = this.identities.get(kind);
    if (existing) return existing;
    const created = this.registerUser(`gdm_bot_${kind}_`).then((identity) => {
      this.log.log(`comparison bot "${kind}" user ${identity.userId}`);
      return identity;
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
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await fetch(`${this.internalUrl}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `${usernamePrefix}${suffix}`,
        password: `${Math.random().toString(36).slice(2)}Aa1!`,
        auth: { type: "m.login.dummy" },
      }),
    });
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
      try {
        const url =
          `${this.internalUrl}/_matrix/client/v3/sync?timeout=30000` +
          (since ? `&since=${encodeURIComponent(since)}` : "");
        const res = await fetch(url, { headers: this.authHeaders() });
        if (!res.ok) {
          await this.delay(2000);
          continue;
        }
        const data = (await res.json()) as SyncResponse;
        since = data.next_batch;
        const joined = data.rooms?.join ?? {};
        for (const roomId of Object.keys(joined)) {
          for (const ev of joined[roomId].timeline?.events ?? []) {
            const event: TimelineEvent = {
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
            for (const handler of this.handlers) handler(event);
          }
        }
      } catch (err) {
        this.log.error(`sync error: ${String(err)}`);
        await this.delay(2000);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
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
