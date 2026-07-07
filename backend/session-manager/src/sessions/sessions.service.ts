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
    let session =
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
      session,
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
    const forming = await this.store.findForming();
    if (!conditionId || forming?.condition.id === conditionId) return forming;
    return (await this.store
      .allSessions())
      .filter(
        (session) =>
          session.status === "waiting" &&
          session.condition.id === conditionId &&
          session.participants.length < session.condition.groupSize,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  private async provision(session: Session): Promise<void> {
    const roomId = await this.matrix.createRoom(
      `GDM ${session.condition.name} · ${session.id.slice(0, 8)}`,
    );
    for (const p of session.participants) {
      const creds = await this.store.getParticipantCreds(p.id);
      if (creds) await this.matrix.joinRoom(creds.accessToken, roomId);
    }
    session.roomId = roomId;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    this.log.log(`provisioned room ${roomId} for session ${session.id}`);
    // Hand the live session to the Chat Service (best-effort — the chat still
    // works client-side if the Chat Service isn't running).
    void this.notifyChatService(session);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      this.log.warn(`chat service notify failed (is it running?): ${String(err)}`);
    }
  }
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
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
