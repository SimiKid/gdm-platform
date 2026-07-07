import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  Condition,
  ExportBundle,
  InterventionSummary,
  Message,
  InterventionLog,
  OpenSessionRequest,
  OpenSessionResponse,
  Participant,
  PublicSession,
  Ranking,
  Session,
  SessionSummary,
  StartSessionNotification,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";

@Injectable()
export class SessionsService {
  private readonly log = new Logger(SessionsService.name);
  /** URL the browser uses to reach Synapse (returned to the client). */
  private readonly publicUrl =
    process.env.MATRIX_PUBLIC_URL ?? "http://localhost:8008";
  /** Chat Service that runs the live session (bot rules). */
  private readonly chatServiceUrl =
    process.env.CHAT_SERVICE_URL ?? "http://localhost:3002";
  /**
   * Waiting sessions older than this are considered abandoned (no-shows) and
   * are aborted so they stop counting against the condition goal. Participants
   * still actively polling an aborted session rejoin automatically.
   */
  private readonly waitingTimeoutMinutes = Number(
    process.env.WAITING_TIMEOUT_MINUTES ?? 30,
  );

  /**
   * Joins must not interleave: find-or-create of the forming session races
   * otherwise, and simultaneous joiners each open their own group that then
   * never fills. In-process serialization suffices for a single instance.
   */
  private openChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: StoreService,
    private readonly matrix: MatrixService,
  ) {}

  /**
   * Waiting-Room entry: place the participant into a forming group, register
   * their Matrix user, and — once the group is full — provision the room and
   * flip the session to "running".
   */
  openSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    const run = this.openChain.then(() => this.doOpenSession(req));
    this.openChain = run.catch(() => undefined); // a failed join must not jam the queue
    return run;
  }

  private async doOpenSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    await this.abortStaleWaiting();

    // A token that already holds a seat gets that seat back (browser refresh,
    // duplicate tab) instead of claiming a second slot and ghosting the first.
    const existing = await this.findByTrackingToken(req.trackingToken);
    if (existing) return this.rejoinResponse(existing.session, existing.participant);

    const session =
      (await this.findForming(req.conditionId)) ??
      (await this.store.createForming(await this.assignCondition(req.conditionId)));

    const creds = await this.matrix.registerUser("gdm");
    const participant: Participant = {
      id: randomUUID(),
      name: req.participantName,
      trackingToken: req.trackingToken,
    };
    session.participants.push(participant);
    await this.store.saveSession(session);
    await this.store.setParticipantCreds(participant.id, creds);

    if (session.participants.length >= session.condition.groupSize) {
      await this.provision(session);
    }
    await this.store.saveSession(session);

    this.log.log(
      `openSession: ${participant.name} -> ${session.condition.name} ` +
        `(${session.participants.length}/${session.condition.groupSize}) ${session.status}`,
    );

    return {
      session: toPublicSession(session),
      participantId: participant.id,
      matrix: {
        homeserverUrl: this.publicUrl,
        userId: creds.userId,
        accessToken: creds.accessToken,
        roomId: session.roomId ?? "",
      },
    };
  }

  /** Mark abandoned waiting groups aborted so they free their condition slot. */
  private async abortStaleWaiting(): Promise<void> {
    const cutoff = Date.now() - this.waitingTimeoutMinutes * 60_000;
    const stale = (await this.store.allSessions()).filter(
      (s) =>
        s.status === "waiting" && new Date(s.createdAt).getTime() < cutoff,
    );
    for (const session of stale) {
      session.status = "aborted";
      await this.store.saveSession(session);
      this.log.log(
        `aborted stale waiting session ${session.id} ` +
          `(${session.participants.length}/${session.condition.groupSize} after ${this.waitingTimeoutMinutes}min)`,
      );
    }
  }

  /** The non-aborted session already holding this tracking token, if any. */
  private async findByTrackingToken(
    token: string,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    if (!token) return undefined;
    for (const session of await this.store.allSessions()) {
      if (session.status === "aborted") continue;
      const participant = session.participants.find(
        (p) => p.trackingToken === token,
      );
      if (participant) return { session, participant };
    }
    return undefined;
  }

  /** Hand a returning participant their existing seat and credentials. */
  private async rejoinResponse(
    session: Session,
    participant: Participant,
  ): Promise<OpenSessionResponse> {
    let creds = await this.store.getParticipantCreds(participant.id);
    if (!creds) {
      // Creds lost (should not happen) — issue fresh ones so they can rejoin.
      creds = await this.matrix.registerUser("gdm");
      await this.store.setParticipantCreds(participant.id, creds);
      if (session.roomId) {
        await this.matrix.invite(session.roomId, creds.userId);
        await this.matrix.joinRoom(creds.accessToken, session.roomId);
      }
    }
    this.log.log(
      `openSession: rejoin ${participant.id} -> session ${session.id} (${session.status})`,
    );
    return {
      session: toPublicSession(session),
      participantId: participant.id,
      matrix: {
        homeserverUrl: this.publicUrl,
        userId: creds.userId,
        accessToken: creds.accessToken,
        roomId: session.roomId ?? "",
      },
    };
  }

  async getSession(id: string): Promise<Session> {
    const session = await this.store.getSession(id);
    if (!session) throw new NotFoundException(`Unknown session ${id}`);
    return session;
  }

  /**
   * The participant-facing view of a session (polled by the Waiting Room):
   * no tracking tokens, no survey answers.
   */
  async getPublicSession(id: string): Promise<PublicSession> {
    return toPublicSession(await this.getSession(id));
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.store
      .allSessions())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toSummary);
  }

  async listInterventions(): Promise<InterventionSummary[]> {
    return (await this.store
      .allSessions())
      .flatMap((session) =>
        session.interventions.map((intervention) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          timestamp: intervention.timestamp,
          mode: intervention.mode,
          audience: intervention.audience,
          tone: intervention.tone,
          targets: intervention.targets,
          quietMembers: intervention.quietMembers,
          contributionSplit: intervention.contributionSplit,
          message: intervention.message,
        })),
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async exportBundle(conditionIds: string[] = []): Promise<ExportBundle> {
    return {
      generatedAt: new Date().toISOString(),
      sessions: await this.filteredSessions(conditionIds),
    };
  }

  /** Sessions restricted to the given conditions (empty = everything). */
  private async filteredSessions(conditionIds: string[] = []): Promise<Session[]> {
    const allowed = new Set(conditionIds);
    return (await this.store
      .allSessions())
      .filter((session) => allowed.size === 0 || allowed.has(session.condition.id));
  }

  async exportCsv(conditionIds: string[] = []): Promise<string> {
    const sessions = (await this.exportBundle(conditionIds)).sessions;
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "status",
        "participant_count",
        "message_count",
        "reaction_count",
        "ranking_edit_count",
        "intervention_count",
        "created_at",
        "started_at",
        "completed_at",
      ],
      ...sessions.map((session) => [
        session.id,
        session.condition.id,
        session.condition.name,
        session.status,
        String(session.participants.length),
        String(session.chat.messages.length),
        String(
          session.chat.messages.reduce(
            (sum, message) => sum + message.reactions.length,
            0,
          ),
        ),
        String(session.rankingHistory?.length ?? 0),
        String(session.interventions.length),
        session.createdAt,
        session.startedAt ?? "",
        session.completedAt ?? "",
      ]),
    ];
    return toCsv(rows);
  }

  /** Chat logs across sessions, one row per message. */
  async exportMessages(conditionIds: string[] = []) {
    return {
      generatedAt: new Date().toISOString(),
      messages: (await this.filteredSessions(conditionIds)).flatMap((session) =>
        session.chat.messages.map((message) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          conditionName: session.condition.name,
          ...message,
        })),
      ),
    };
  }

  async exportMessagesCsv(conditionIds: string[] = []): Promise<string> {
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "message_id",
        "timestamp",
        "sender_id",
        "recipient_id",
        "text",
        "reaction_count",
        "reaction_keys",
      ],
      ...(await this.exportMessages(conditionIds)).messages.map((m) => [
        m.sessionId,
        m.conditionId,
        m.conditionName,
        m.id,
        m.timestamp,
        m.senderId,
        m.recipientId ?? "",
        m.text,
        String(m.reactions.length),
        m.reactions.map((reaction) => reaction.key).join("|"),
      ]),
    ];
    return toCsv(rows);
  }

  /** Bot nudge events across sessions, one row per intervention. */
  async exportInterventions(conditionIds: string[] = []) {
    return {
      generatedAt: new Date().toISOString(),
      interventions: (await this.filteredSessions(conditionIds)).flatMap(
        (session) =>
          session.interventions.map((intervention) => ({
            conditionName: session.condition.name,
            ...intervention,
          })),
      ),
    };
  }

  async exportInterventionsCsv(conditionIds: string[] = []): Promise<string> {
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "timestamp",
        "mode",
        "audience",
        "tone",
        "trigger",
        "threshold",
        "targets",
        "quiet_members",
        "message",
      ],
      ...(await this.exportInterventions(conditionIds)).interventions.map((i) => [
        i.sessionId,
        i.conditionId,
        i.conditionName,
        i.timestamp,
        i.mode,
        i.audience,
        i.tone,
        i.trigger,
        String(i.threshold),
        i.targets.map((target) => target.identityName).join("|"),
        i.quietMembers.map((member) => member.identityName).join("|"),
        i.message,
      ]),
    ];
    return toCsv(rows);
  }

  /** Survey responses across sessions, one row per participant and kind. */
  async exportSurveys(conditionIds: string[] = []) {
    return {
      generatedAt: new Date().toISOString(),
      surveys: (await this.filteredSessions(conditionIds)).flatMap((session) =>
        session.participants.flatMap((participant) =>
          (
            [
              ["entry", participant.entrySurvey],
              ["exit", participant.exitSurvey],
            ] as const
          )
            .filter(([, survey]) => survey !== undefined)
            .map(([kind, survey]) => ({
              sessionId: session.id,
              conditionId: session.condition.id,
              conditionName: session.condition.name,
              participantId: participant.id,
              participantName: participant.name,
              trackingToken: participant.trackingToken,
              kind,
              submittedAt: survey?.submittedAt ?? "",
              answers: survey?.answers ?? {},
            })),
        ),
      ),
    };
  }

  async exportSurveysCsv(conditionIds: string[] = []): Promise<string> {
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "participant_id",
        "participant_name",
        "tracking_token",
        "kind",
        "submitted_at",
        "answers_json",
      ],
      ...(await this.exportSurveys(conditionIds)).surveys.map((s) => [
        s.sessionId,
        s.conditionId,
        s.conditionName,
        s.participantId,
        s.participantName,
        s.trackingToken,
        s.kind,
        s.submittedAt,
        JSON.stringify(s.answers),
      ]),
    ];
    return toCsv(rows);
  }

  /** Mark a session completed (idempotent) — drives progress & auto-off. */
  async completeSession(id: string): Promise<Session> {
    const session = await this.getSession(id);
    if (session.status !== "completed" && session.status !== "aborted") {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
      await this.store.saveSession(session);
      this.log.log(`session ${session.id} completed (${session.condition.name})`);
    }
    return session;
  }

  /** Persist the discussion returned by the Chat Service at session end. */
  async finalizeSession(
    id: string,
    messages: Message[],
    rankingHistory: Ranking[],
    interventions: InterventionLog[] = [],
  ): Promise<Session> {
    const session = await this.getSession(id);
    session.chat.messages = messages;
    session.rankingHistory = rankingHistory;
    session.interventions = interventions;
    if (rankingHistory.length > 0) {
      session.ranking = rankingHistory[rankingHistory.length - 1];
    }
    if (session.status !== "aborted") {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
    }
    await this.store.saveSession(session);
    this.log.log(
      `finalized session ${id}: ${messages.length} messages, ` +
        `${rankingHistory.length} ranking edits, ` +
        `${interventions.length} interventions`,
    );
    return session;
  }

  async submitSurvey(req: SubmitSurveyRequest): Promise<void> {
    const session = await this.getSession(req.sessionId);
    const participant = session.participants.find((p) => p.id === req.participantId);
    if (!participant) throw new NotFoundException(`Unknown participant ${req.participantId}`);
    if (req.kind === "entry") participant.entrySurvey = req.survey;
    else participant.exitSurvey = req.survey;
    await this.store.saveSession(session);
  }

  /** Least-completed active condition that hasn't reached its goal. */
  private async assignCondition(conditionId?: string): Promise<Condition> {
    if (conditionId) {
      const condition = await this.store.getCondition(conditionId);
      if (!condition) {
        throw new NotFoundException(`Unknown condition ${conditionId}`);
      }
      if (
        !condition.active ||
        (await this.store.claimedCount(condition.id)) >= condition.goal
      ) {
        throw new ConflictException(`Condition ${conditionId} is not available`);
      }
      return condition;
    }

    const conditions = await this.store.listConditions();
    const counts = new Map<string, number>();
    for (const condition of conditions) {
      counts.set(condition.id, await this.store.claimedCount(condition.id));
    }
    const candidate = conditions
      .filter((c) => c.active && (counts.get(c.id) ?? 0) < c.goal)
      .sort((a, b) => (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0))[0];
    if (!candidate) throw new ConflictException("Study is full — no active condition needs participants");
    return candidate;
  }

  private async findForming(conditionId?: string): Promise<Session | undefined> {
    // session.condition is a snapshot; check the researcher's CURRENT active
    // flag so a deactivated arm stops recruiting even mid-formation.
    const activeIds = new Set(
      (await this.store.listConditions())
        .filter((c) => c.active)
        .map((c) => c.id),
    );
    return (await this.store
      .allSessions())
      .filter(
        (session) =>
          session.status === "waiting" &&
          activeIds.has(session.condition.id) &&
          session.participants.length < session.condition.groupSize &&
          (!conditionId || session.condition.id === conditionId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  private async provision(session: Session): Promise<void> {
    const roomId = await this.matrix.createRoom(
      `GDM ${session.condition.name} · ${session.id.slice(0, 8)}`,
    );
    // Rooms are invite-only: with open registration on the homeserver, a
    // public_chat preset would let anyone with the room id join a live study.
    for (const p of session.participants) {
      const creds = await this.store.getParticipantCreds(p.id);
      if (!creds) continue;
      await this.matrix.invite(roomId, creds.userId);
      await this.matrix.joinRoom(creds.accessToken, roomId);
    }
    // Invite the Chat Service bot so it can join when it takes the session
    // over (best-effort — the chat still works client-side without the bot).
    const botUserId = await this.fetchBotUserId();
    if (botUserId) await this.matrix.invite(roomId, botUserId);

    session.roomId = roomId;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    this.log.log(`provisioned room ${roomId} for session ${session.id}`);
    void this.notifyChatService(session);
  }

  /** Ask the Chat Service which Matrix user its bot runs as. */
  private async fetchBotUserId(): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.chatServiceUrl}/internal/bot`, {
        headers: internalHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { userId?: string };
      return data.userId || undefined;
    } catch (err) {
      this.log.warn(`could not resolve bot user (chat service down?): ${String(err)}`);
      return undefined;
    }
  }

  private async notifyChatService(session: Session): Promise<void> {
    const payload: StartSessionNotification = {
      sessionId: session.id,
      roomId: session.roomId ?? "",
      condition: session.condition,
      durationMinutes: session.durationMinutes,
    };
    try {
      await fetch(`${this.chatServiceUrl}/internal/sessions/start`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.log.warn(`chat service notify failed (is it running?): ${String(err)}`);
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

/** Strip per-participant secrets before a session leaves the participant API. */
function toPublicSession(session: Session): PublicSession {
  return {
    ...session,
    participants: session.participants.map((p) => ({ id: p.id, name: p.name })),
  };
}

function toSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    status: session.status,
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    participantCount: session.participants.length,
    groupSize: session.condition.groupSize,
    messageCount: session.chat.messages.length,
    interventionCount: session.interventions.length,
    rankingEditCount: session.rankingHistory?.length ?? 0,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    roomId: session.roomId,
  };
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  // Guard against spreadsheet formula injection: participant-authored text
  // starting with = + - @ would execute when the CSV is opened in Excel.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (!/[",\n]/.test(guarded)) return guarded;
  return `"${guarded.replaceAll('"', '""')}"`;
}
