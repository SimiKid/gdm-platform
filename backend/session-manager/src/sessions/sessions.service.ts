import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isServiceUser } from "@gdm/shared";
import type {
  CheckpointSessionRequest,
  Condition,
  ContributionAggregate,
  ExportBundle,
  InterventionSummary,
  OpenSessionRequest,
  OpenSessionResponse,
  Participant,
  PublicSession,
  Session,
  SessionSummary,
  StartSessionNotification,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";
import { toCsv } from "../reports/csv";
import { filterResearchSessions } from "../reports/filter";

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
    return filterResearchSessions(await this.store.allSessions(), conditionIds);
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
        "trigger",
        "threshold",
        "llm_mode",
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
        i.trigger,
        String(i.threshold),
        i.llmMode ?? "off",
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

  async exportContributions(conditionIds: string[] = []) {
    const sessions = await this.filteredSessions(conditionIds);
    return {
      generatedAt: new Date().toISOString(),
      contributions: sessions.flatMap(contributionAggregates),
      behavioralEvents: sessions.flatMap((session) =>
        session.behavioralEvents.map((event) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          ...event,
        })),
      ),
      classifications: sessions.flatMap((session) =>
        session.contributionClassifications.map((classification) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          ...classification,
        })),
      ),
    };
  }

  async exportContributionsCsv(conditionIds: string[] = []): Promise<string> {
    const rows = [
      [
        "session_id",
        "condition_id",
        "participant_id",
        "message_count",
        "character_count",
        "reaction_count",
        "ranking_move_count",
        "typing_duration_ms",
        "responds_to_prior_count",
        "references_task_item_count",
        "has_discussion_structure_count",
        "invites_participation_count",
        "meaningfulness_score_mean",
      ],
      ...(await this.exportContributions(conditionIds)).contributions.map((c) => [
        c.sessionId,
        c.conditionId,
        c.participantId,
        String(c.messageCount),
        String(c.characterCount),
        String(c.reactionCount),
        String(c.rankingMoveCount),
        String(c.typingDurationMs),
        String(c.respondsToPriorCount),
        String(c.referencesTaskItemCount),
        String(c.hasDiscussionStructureCount),
        String(c.invitesParticipationCount),
        String(c.meaningfulnessScoreMean),
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

  /** Persist live state without changing the session lifecycle. */
  async checkpointSession(
    id: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<Session> {
    const session = await this.getSession(id);
    applyCheckpoint(session, checkpoint);
    await this.store.saveRuntimeCheckpoint(session);
    return session;
  }

  /** Persist the discussion returned by the Chat Service at session end. */
  async finalizeSession(
    id: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<Session> {
    const session = await this.getSession(id);
    applyCheckpoint(session, checkpoint);
    if ((session.rankingHistory?.length ?? 0) > 0) {
      session.ranking = session.rankingHistory![session.rankingHistory!.length - 1];
    }
    if (session.status !== "aborted") {
      session.status = "completed";
      session.completedAt = new Date().toISOString();
    }
    await this.store.saveSession(session);
    this.log.log(
      `finalized session ${id}: ${session.chat.messages.length} messages, ` +
        `${session.rankingHistory?.length ?? 0} ranking edits, ` +
        `${session.interventions.length} interventions`,
    );
    return session;
  }

  /** Re-authorize a new bot account after chat-service restart. */
  async recoverRunningSessions(
    botUserId: string,
    comparisonBotUserIds: string[] = [],
  ): Promise<StartSessionNotification[]> {
    if (!botUserId) throw new ConflictException("botUserId is required");
    const running = (await this.store.allSessions()).filter(
      (session) => session.status === "running" && session.roomId,
    );
    const notes: StartSessionNotification[] = [];
    for (const session of running) {
      await this.matrix.invite(session.roomId!, botUserId);
      if (session.condition.config.comparisonMode === true) {
        for (const comparisonUserId of comparisonBotUserIds) {
          try {
            await this.matrix.invite(session.roomId!, comparisonUserId);
          } catch (err) {
            this.log.warn(
              `comparison bot re-invite failed for ${comparisonUserId}: ${String(err)}`,
            );
          }
        }
      }
      notes.push({
        sessionId: session.id,
        roomId: session.roomId!,
        condition: session.condition,
        durationMinutes: session.durationMinutes,
        startedAt: session.startedAt,
        checkpoint: {
          messages: session.chat.messages,
          rankingHistory: session.rankingHistory ?? [],
          interventions: session.interventions,
          behavioralEvents: session.behavioralEvents,
          contributionClassifications: session.contributionClassifications,
          windowEvaluations: session.windowEvaluations ?? [],
          classificationFailures: session.classificationFailures ?? [],
          processedEventIds: session.processedEventIds ?? [],
          ruleState: session.runtimeState ?? {},
        },
      });
    }
    return notes;
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
    // Comparison conditions additionally need Assistant A/B invited: rooms
    // are invite-only, so an uninvited bot's join is rejected with 403.
    const bot = await this.fetchBotIdentity();
    if (bot.userId) await this.matrix.invite(roomId, bot.userId);
    if (session.condition.config.comparisonMode === true) {
      for (const comparisonUserId of bot.comparisonUserIds) {
        try {
          await this.matrix.invite(roomId, comparisonUserId);
        } catch (err) {
          this.log.warn(
            `comparison bot invite failed for ${comparisonUserId}: ${String(err)}`,
          );
        }
      }
    }

    session.roomId = roomId;
    session.status = "running";
    session.startedAt = new Date().toISOString();
    this.log.log(`provisioned room ${roomId} for session ${session.id}`);
    void this.notifyChatService(session);
  }

  /** Ask the Chat Service which Matrix users its bots run as. */
  private async fetchBotIdentity(): Promise<{
    userId?: string;
    comparisonUserIds: string[];
  }> {
    try {
      const res = await fetch(`${this.chatServiceUrl}/internal/bot`, {
        headers: internalHeaders(),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as {
        userId?: string;
        comparisonUserIds?: string[];
      };
      return {
        userId: data.userId || undefined,
        comparisonUserIds: data.comparisonUserIds ?? [],
      };
    } catch (err) {
      this.log.warn(`could not resolve bot user (chat service down?): ${String(err)}`);
      return { userId: undefined, comparisonUserIds: [] };
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
    try {
      const res = await fetch(`${this.chatServiceUrl}/internal/sessions/start`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    } catch (err) {
      this.log.warn(`chat service notify failed (is it running?): ${String(err)}`);
    }
  }
}

function applyCheckpoint(
  session: Session,
  checkpoint: CheckpointSessionRequest,
): void {
  session.chat.messages = checkpoint.messages ?? [];
  session.rankingHistory = checkpoint.rankingHistory ?? [];
  session.interventions = checkpoint.interventions ?? [];
  session.behavioralEvents = checkpoint.behavioralEvents ?? [];
  session.contributionClassifications =
    checkpoint.contributionClassifications ?? [];
  session.windowEvaluations = checkpoint.windowEvaluations ?? [];
  session.classificationFailures = checkpoint.classificationFailures ?? [];
  session.processedEventIds = checkpoint.processedEventIds ?? [];
  session.runtimeState = checkpoint.ruleState ?? {};
  if (session.rankingHistory.length > 0) {
    session.ranking = session.rankingHistory[session.rankingHistory.length - 1];
  }
}

function contributionAggregates(session: Session): ContributionAggregate[] {
  const ids = new Set<string>();
  for (const message of session.chat.messages) {
    ids.add(message.senderId);
    for (const reaction of message.reactions) ids.add(reaction.senderId);
  }
  for (const event of session.behavioralEvents) ids.add(event.participantId);
  for (const item of session.contributionClassifications) ids.add(item.senderId);
  // Bot messages are part of the chat log but bots never get a contribution row.
  for (const id of ids) if (isServiceUser(id)) ids.delete(id);

  return [...ids].sort().map((participantId) => {
    const messages = session.chat.messages.filter(
      (message) => message.senderId === participantId,
    );
    const classifications = session.contributionClassifications.filter(
      (item) => item.senderId === participantId,
    );
    return {
      sessionId: session.id,
      conditionId: session.condition.id,
      participantId,
      messageCount: messages.length,
      characterCount: messages.reduce((sum, message) => sum + message.text.length, 0),
      reactionCount: session.chat.messages.reduce(
        (sum, message) =>
          sum + message.reactions.filter((reaction) => reaction.senderId === participantId).length,
        0,
      ),
      rankingMoveCount: session.behavioralEvents.filter(
        (event) => event.participantId === participantId && event.type === "ranking-move",
      ).length,
      typingDurationMs: session.behavioralEvents
        .filter(
          (event) => event.participantId === participantId && event.type === "typing-stop",
        )
        .reduce((sum, event) => sum + (event.durationMs ?? 0), 0),
      respondsToPriorCount: classifications.filter(
        (item) => item.respondsToPrior.value,
      ).length,
      referencesTaskItemCount: classifications.filter(
        (item) => item.referencesTaskItem.value,
      ).length,
      hasDiscussionStructureCount: classifications.filter(
        (item) => item.hasDiscussionStructure.value,
      ).length,
      invitesParticipationCount: classifications.filter(
        (item) => item.invitesParticipation.value,
      ).length,
      meaningfulnessScoreMean:
        classifications.length > 0
          ? classifications.reduce((sum, item) => sum + item.meaningfulnessScore, 0) /
            classifications.length
          : 0,
    };
  });
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
  const {
    behavioralEvents: _behavioralEvents,
    contributionClassifications: _contributionClassifications,
    windowEvaluations: _windowEvaluations,
    classificationFailures: _classificationFailures,
    processedEventIds: _processedEventIds,
    runtimeState: _runtimeState,
    ...publicFields
  } = session;
  return {
    ...publicFields,
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

