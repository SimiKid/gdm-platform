import type { Logger } from "@nestjs/common";
import { internalHeaders } from "@gdm/shared/server";
import type {
  Participant,
  Session,
  StartSessionNotification,
} from "@gdm/shared";
import type { MatrixCreds, MatrixService } from "../matrix/matrix.service";
import type { StoreService } from "../store/store.service";

/** Matrix power level that lets the bot redact abusive messages. */
const BOT_MODERATOR_POWER_LEVEL = 50;
/** Timeout of the bot-identity request. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** Timeout of the Chat Service session start. */
const CHAT_SERVICE_START_TIMEOUT_MS = 15_000;

/**
 * Matrix side of a session: one durable identity per participant and, once
 * a group is complete, one invite-only room with every member and the Chat
 * Service bot, published only after the Chat Service accepted the session.
 *
 * Each operation is single-flight per participant/session, so concurrent
 * joins and Waiting Room polls never register twice or split a group.
 */
export class RoomProvisioner {
  /** Chat Service that runs the live session (bot rules). */
  private readonly chatServiceUrl =
    process.env.CHAT_SERVICE_URL ?? "http://localhost:3002";
  /** One Matrix credential operation per participant, including re-invites. */
  private readonly participantAccessChains = new Map<
    string,
    Promise<MatrixCreds>
  >();
  /** At most one room-provisioning attempt per forming session. */
  private readonly provisionChains = new Map<string, Promise<Session>>();

  constructor(
    private readonly store: StoreService,
    private readonly matrix: MatrixService,
    private readonly log: Logger,
    /** Load a session, failing for an unknown id. */
    private readonly getSession: (id: string) => Promise<Session>,
  ) {}

  /**
   * A complete group still waiting for its room: start provisioning without
   * blocking the caller (`what` labels the log line of a failed attempt).
   */
  provisionInBackgroundIfFull(session: Session, what: string): void {
    if (
      (session.status !== "waiting" && session.status !== "provisioning") ||
      session.participants.length < session.condition.groupSize
    ) {
      return;
    }
    void this.ensureProvisioned(session.id).catch((error) =>
      this.log.warn(`${what} failed for ${session.id}: ${String(error)}`),
    );
  }

  /**
   * Ensure one durable Matrix identity per participant. A failed registration
   * leaves the reserved seat intact; a retry resumes it instead of duplicating
   * the participant or losing their survey linkage.
   */
  ensureParticipantAccess(
    session: Session,
    participant: Participant,
  ): Promise<MatrixCreds> {
    const existing = this.participantAccessChains.get(participant.id);
    if (existing) return existing;

    const run = (async () => {
      let creds = await this.store.getParticipantCreds(participant.id);
      if (creds) return creds;

      creds = await this.matrix.registerUser("gdm");
      await this.store.setParticipantCreds(participant.id, creds);
      // Recovery edge case: a running room survived while this participant's
      // credentials did not. Restore access once, inside the same single-flight.
      if (session.roomId) {
        await this.matrix.invite(session.roomId, creds.userId);
        await this.matrix.joinRoom(creds.accessToken, session.roomId);
      }
      return creds;
    })();
    this.participantAccessChains.set(participant.id, run);
    void run.finally(() => {
      if (this.participantAccessChains.get(participant.id) === run) {
        this.participantAccessChains.delete(participant.id);
      }
    }).catch(() => undefined);
    return run;
  }

  /** Invite a bot into a room and let it redact abusive messages. */
  async grantBotAccess(roomId: string, botUserId: string): Promise<void> {
    await this.matrix.invite(roomId, botUserId);
    await this.matrix.setUserPowerLevel(
      roomId,
      botUserId,
      BOT_MODERATOR_POWER_LEVEL,
    );
  }

  /** Provision a full group once, independently from other arriving groups. */
  private ensureProvisioned(id: string): Promise<Session> {
    const existing = this.provisionChains.get(id);
    if (existing) return existing;

    const run = (async () => {
      let session = await this.getSession(id);
      if (
        (session.status !== "waiting" && session.status !== "provisioning") ||
        session.participants.length < session.condition.groupSize
      ) {
        return session;
      }
      for (const participant of session.participants) {
        if (!(await this.store.getParticipantCreds(participant.id))) {
          return session;
        }
      }
      if (session.status === "waiting") {
        const claimed = await this.store.claimSessionProvisioning(id);
        if (!claimed) return this.getSession(id);
        session = await this.getSession(id);
      }
      await this.provision(session);
      return this.getSession(id);
    })();
    this.provisionChains.set(id, run);
    void run.finally(() => {
      if (this.provisionChains.get(id) === run) this.provisionChains.delete(id);
    }).catch(() => undefined);
    return run;
  }

  private async provision(session: Session): Promise<void> {
    let roomId = session.roomId;
    if (!roomId) {
      roomId = await this.matrix.createRoom(
        `GDM ${session.condition.name} · ${session.id.slice(0, 8)}`,
      );
      // Keep the private room as a recovery handle while it is still hidden
      // from participants. A restart resumes this room instead of creating a
      // second one and splitting the group.
      await this.store.updateSessionLifecycle(session.id, { roomId });
      session.roomId = roomId;
    }
    // Rooms are invite-only: with open registration on the homeserver, a
    // public_chat preset would let anyone with the room id join a live study.
    for (const p of session.participants) {
      const creds = await this.store.getParticipantCreds(p.id);
      if (!creds) {
        throw new Error(`participant ${p.id} has no Matrix credentials`);
      }
      await this.ensureMatrixMember(roomId, creds);
    }
    // Invite the Chat Service bot so it can join when it takes the session
    // over (best-effort — the chat still works client-side without the bot).
    // Rooms are invite-only, so an uninvited bot's join is rejected with 403.
    const bot = await this.fetchBotIdentity();
    if (bot.userId) {
      try {
        // Grant redaction rights so the bot can moderate abusive messages.
        await this.grantBotAccess(roomId, bot.userId);
      } catch (error) {
        // On a retry the primary bot may already be invited or joined. The
        // idempotent Chat Service start below is the authoritative check.
        this.log.warn(`primary bot invite retry failed: ${String(error)}`);
      }
    }

    const startedAt = new Date().toISOString();
    const readySession: Session = {
      ...session,
      roomId,
      status: "running",
      startedAt,
    };
    // Recording and the server-side timer must accept the session before its
    // room becomes visible. POST /start is idempotent, so a lost response can
    // safely be retried by the waiting-room poll.
    await this.notifyChatService(readySession);
    const published = await this.store.finishSessionProvisioning(
      session.id,
      roomId,
      startedAt,
    );
    if (!published) {
      throw new Error(
        `session ${session.id} left provisioning before the room was ready`,
      );
    }
    session.status = "running";
    session.startedAt = startedAt;
    this.log.log(`provisioned room ${roomId} for session ${session.id}`);
  }

  /**
   * Invite then join one participant, tolerating a recovery after they already
   * joined. An invite error is ignored only when the authenticated join proves
   * that access already exists.
   */
  private async ensureMatrixMember(
    roomId: string,
    creds: MatrixCreds,
  ): Promise<void> {
    let inviteError: unknown;
    try {
      await this.matrix.invite(roomId, creds.userId);
    } catch (error) {
      inviteError = error;
    }
    try {
      await this.matrix.joinRoom(creds.accessToken, roomId);
    } catch (joinError) {
      if (inviteError) {
        throw new Error(
          `could not restore ${creds.userId} room access: ` +
            `${String(inviteError)}; ${String(joinError)}`,
        );
      }
      throw joinError;
    }
  }

  /** Ask the Chat Service which Matrix user its bot runs as. */
  private async fetchBotIdentity(): Promise<{ userId?: string }> {
    try {
      const res = await fetch(`${this.chatServiceUrl}/internal/bot`, {
        headers: internalHeaders(),
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { userId?: string };
      return { userId: data.userId || undefined };
    } catch (err) {
      this.log.warn(`could not resolve bot user (chat service down?): ${String(err)}`);
      return { userId: undefined };
    }
  }

  private async notifyChatService(session: Session): Promise<void> {
    const payload: StartSessionNotification = {
      sessionId: session.id,
      roomId: session.roomId ?? "",
      condition: session.condition,
      durationMinutes: session.durationMinutes,
      startedAt: session.startedAt,
    };
    const res = await fetch(`${this.chatServiceUrl}/internal/sessions/start`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_SERVICE_START_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`chat service start failed (${res.status})`);
  }
}
