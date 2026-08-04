import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isServiceUser } from "@gdm/shared";
import type {
  CheckpointSessionRequest,
  CompleteParticipantResponse,
  Condition,
  ContributionAggregate,
  ExportBundle,
  InterventionSummary,
  OpenSessionRequest,
  OpenSessionResponse,
  Participant,
  ProlificArrival,
  ProlificIdentity,
  ProlificResumeResponse,
  PublicSession,
  Session,
  SessionSummary,
  StartRoundResponse,
  StartSessionNotification,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";
import { toCsv } from "../reports/csv";
import {
  filterResearchSessions,
  type ResearchFilter,
} from "../reports/filter";

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
  /** Avoid repeating the Prolific API lookup across arrival → resume → join. */
  private readonly verifiedProlificSubmissions = new Map<string, number>();

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

  /**
   * Close the current study round and open the next one. Rides the same
   * serialization chain as joins, so a round switch can never interleave
   * with a participant entering a lobby: the joiner either lands in the old
   * round before its lobbies are aborted, or opens a fresh current-round
   * session afterwards.
   */
  startRound(label?: string): Promise<StartRoundResponse> {
    const run = this.openChain.then(() => this.doStartRound(label ?? ""));
    this.openChain = run.catch(() => undefined);
    return run;
  }

  private async doStartRound(label: string): Promise<StartRoundResponse> {
    // Abort leftover lobbies so no group mixes participants across rounds.
    // Participants still polling an aborted session rejoin automatically —
    // into the new round. Running sessions finish in their round.
    const waiting = (await this.store.allSessions()).filter(
      (session) => session.status === "waiting",
    );
    for (const session of waiting) {
      session.status = "aborted";
      await this.store.saveSession(session);
    }
    const round = await this.store.startNewRound(label);
    this.log.log(
      `started round ${round.id} ("${round.label}"), aborted ${waiting.length} waiting lobbies`,
    );
    return {
      round: {
        number: round.id,
        label: round.label,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        sessionCount: 0,
        completedCount: 0,
      },
      abortedWaitingSessions: waiting.length,
    };
  }

  private async doOpenSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    await this.abortStaleWaiting();
    await this.validateProlificIdentity(req.prolific);
    if (req.prolific) await this.store.recordProlificArrival(req.prolific);

    // A token that already holds a seat gets that seat back (browser refresh,
    // duplicate tab) instead of claiming a second slot and ghosting the first.
    const existing = req.prolific
      ? await this.findByProlificSession(req.prolific)
      : await this.findByTrackingToken(req.trackingToken);
    if (existing) {
      if (req.prolific) {
        await this.store.linkProlificArrival(
          req.prolific,
          existing.participant.id,
        );
      }
      return this.rejoinResponse(existing.session, existing.participant);
    }

    const session =
      (await this.findForming(req.conditionId)) ??
      (await this.store.createForming(await this.assignCondition(req.conditionId)));

    const creds = await this.matrix.registerUser("gdm");
    const participant: Participant = {
      id: randomUUID(),
      name: req.participantName,
      trackingToken: req.trackingToken,
      prolific: req.prolific,
    };
    session.participants.push(participant);
    await this.store.saveSession(session);
    await this.store.setParticipantCreds(participant.id, creds);
    if (req.prolific) {
      await this.store.linkProlificArrival(req.prolific, participant.id);
    }

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

  /** Find the exact Prolific submission even if the client token changes. */
  private async findByProlificSession(
    identity: ProlificIdentity,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    for (const session of await this.store.allSessions()) {
      if (session.status === "aborted") continue;
      const participant = session.participants.find(
        (p) =>
          p.prolific?.studyId === identity.studyId &&
          p.prolific.sessionId === identity.sessionId,
      );
      if (!participant) continue;
      if (participant.prolific?.participantId !== identity.participantId) {
        throw new ConflictException(
          "This Prolific submission belongs to a different participant",
        );
      }
      return { session, participant };
    }
    return undefined;
  }

  /** Validate URL identifiers and, when configured, their Prolific submission. */
  private async validateProlificIdentity(
    identity?: ProlificIdentity,
  ): Promise<void> {
    if (!identity) return;
    const idPattern = /^[a-f0-9]{24}$/i;
    if (
      !idPattern.test(identity.participantId) ||
      !idPattern.test(identity.studyId) ||
      !idPattern.test(identity.sessionId)
    ) {
      throw new BadRequestException("Invalid Prolific identifiers");
    }
    const expectedStudyId = process.env.PROLIFIC_STUDY_ID?.trim();
    if (expectedStudyId && identity.studyId !== expectedStudyId) {
      throw new BadRequestException("Unexpected Prolific study");
    }

    const apiToken = process.env.PROLIFIC_API_TOKEN?.trim();
    if (!apiToken) return;

    const cacheKey = [
      identity.studyId,
      identity.sessionId,
      identity.participantId,
    ].join(":");
    const cachedUntil = this.verifiedProlificSubmissions.get(cacheKey) ?? 0;
    if (cachedUntil > Date.now()) return;

    let response: Response;
    try {
      response = await fetch(
        `https://api.prolific.com/api/v1/submissions/${identity.sessionId}/`,
        {
          headers: { Authorization: `Token ${apiToken}` },
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch (error) {
      this.log.error(`Prolific submission verification failed: ${String(error)}`);
      throw new ServiceUnavailableException(
        "Prolific submission verification is temporarily unavailable",
      );
    }

    if (response.status === 404) {
      throw new BadRequestException("Unknown Prolific submission");
    }
    if (!response.ok) {
      this.log.error(
        `Prolific submission verification returned ${response.status}`,
      );
      throw new ServiceUnavailableException(
        "Prolific submission verification is temporarily unavailable",
      );
    }

    const submission = (await response.json()) as {
      id?: string;
      study_id?: string;
      participant?: string;
      status?: string;
    };
    if (
      submission.id !== identity.sessionId ||
      submission.study_id !== identity.studyId ||
      submission.participant !== identity.participantId
    ) {
      throw new BadRequestException("Prolific submission identity mismatch");
    }
    // Prolific's current API documents underscore-separated enum values, while
    // older responses used display-style spaces. Normalize both forms so a
    // legitimate participant can still resume after submitting their study.
    const submissionStatus = submission.status
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    if (
      submissionStatus &&
      !["RESERVED", "ACTIVE", "AWAITING_REVIEW", "APPROVED"].includes(
        submissionStatus,
      )
    ) {
      throw new BadRequestException(
        `Prolific submission is ${submissionStatus.toLowerCase()}`,
      );
    }

    this.verifiedProlificSubmissions.set(cacheKey, Date.now() + 60_000);
  }

  async recordProlificArrival(
    identity: ProlificIdentity,
  ): Promise<ProlificArrival> {
    await this.validateProlificIdentity(identity);
    return this.store.recordProlificArrival(identity);
  }

  /** Restore a Prolific submission after the original browser tab was closed. */
  async resumeProlific(
    identity: ProlificIdentity,
  ): Promise<ProlificResumeResponse | null> {
    await this.validateProlificIdentity(identity);
    const existing = await this.findByProlificSession(identity);
    if (!existing) return null;

    const openSession = await this.rejoinResponse(
      existing.session,
      existing.participant,
    );
    const stage =
      existing.participant.completedAt || existing.participant.exitSurvey
        ? "done"
        : existing.session.status === "completed"
          ? "exit"
          : existing.session.roomId
            ? "chat"
            : "waiting";
    return { stage, openSession };
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

  async exportBundle(filter: ResearchFilter = {}): Promise<ExportBundle> {
    return {
      generatedAt: new Date().toISOString(),
      sessions: await this.filteredSessions(filter),
    };
  }

  /** Sessions restricted to the given conditions/rounds (empty = everything). */
  private async filteredSessions(filter: ResearchFilter = {}): Promise<Session[]> {
    return filterResearchSessions(await this.store.allSessions(), filter);
  }

  async exportCsv(filter: ResearchFilter = {}): Promise<string> {
    const sessions = (await this.exportBundle(filter)).sessions;
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "round",
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
        String(session.roundId),
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
  async exportMessages(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      messages: (await this.filteredSessions(filter)).flatMap((session) =>
        session.chat.messages.map((message) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          conditionName: session.condition.name,
          ...message,
        })),
      ),
    };
  }

  async exportMessagesCsv(filter: ResearchFilter = {}): Promise<string> {
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
      ...(await this.exportMessages(filter)).messages.map((m) => [
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
  async exportInterventions(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      interventions: (await this.filteredSessions(filter)).flatMap(
        (session) =>
          session.interventions.map((intervention) => ({
            conditionName: session.condition.name,
            ...intervention,
          })),
      ),
    };
  }

  async exportInterventionsCsv(filter: ResearchFilter = {}): Promise<string> {
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
      ...(await this.exportInterventions(filter)).interventions.map((i) => [
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
  async exportSurveys(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      surveys: (await this.filteredSessions(filter)).flatMap((session) =>
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
              prolificPid: participant.prolific?.participantId ?? "",
              prolificStudyId: participant.prolific?.studyId ?? "",
              prolificSessionId: participant.prolific?.sessionId ?? "",
              participantCompletedAt: participant.completedAt ?? "",
              kind,
              submittedAt: survey?.submittedAt ?? "",
              answers: survey?.answers ?? {},
            })),
        ),
      ),
    };
  }

  async exportSurveysCsv(filter: ResearchFilter = {}): Promise<string> {
    const rows = [
      [
        "session_id",
        "condition_id",
        "condition_name",
        "participant_id",
        "participant_name",
        "tracking_token",
        "prolific_pid",
        "prolific_study_id",
        "prolific_session_id",
        "participant_completed_at",
        "kind",
        "submitted_at",
        "answers_json",
      ],
      ...(await this.exportSurveys(filter)).surveys.map((s) => [
        s.sessionId,
        s.conditionId,
        s.conditionName,
        s.participantId,
        s.participantName,
        s.trackingToken,
        s.prolificPid,
        s.prolificStudyId,
        s.prolificSessionId,
        s.participantCompletedAt,
        s.kind,
        s.submittedAt,
        JSON.stringify(s.answers),
      ]),
    ];
    return toCsv(rows);
  }

  async exportContributions(filter: ResearchFilter = {}) {
    const sessions = await this.filteredSessions(filter);
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

  async exportContributionsCsv(filter: ResearchFilter = {}): Promise<string> {
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
      ...(await this.exportContributions(filter)).contributions.map((c) => [
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

  /**
   * Record compensation eligibility per participant, not per group.
   * Idempotent so a refresh on the debriefing screen can retrieve the URL.
   */
  async completeParticipant(
    sessionId: string,
    participantId: string,
  ): Promise<CompleteParticipantResponse> {
    const session = await this.getSession(sessionId);
    const participant = session.participants.find((p) => p.id === participantId);
    if (!participant) {
      throw new NotFoundException(`Unknown participant ${participantId}`);
    }
    if (!participant.exitSurvey) {
      throw new ConflictException(
        "The exit survey must be submitted before completion",
      );
    }
    if (!participant.completedAt) {
      participant.completedAt = new Date().toISOString();
      await this.store.saveSession(session);
      this.log.log(
        `participant ${participant.id} completed session ${session.id}`,
      );
    }
    const settings = await this.store.getStudySettings();
    return {
      completedAt: participant.completedAt,
      compensationUrl: settings.compensationUrl,
    };
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

  /**
   * Least-claimed active condition that hasn't reached its goal — counted
   * within the CURRENT round, so an arm that filled its goal in an earlier
   * round recruits again after a round switch.
   */
  private async assignCondition(conditionId?: string): Promise<Condition> {
    const round = await this.store.currentRound();
    if (conditionId) {
      const condition = await this.store.getCondition(conditionId);
      if (!condition) {
        throw new NotFoundException(`Unknown condition ${conditionId}`);
      }
      if (
        !condition.active ||
        (await this.store.claimedCount(condition.id, round.id)) >= condition.goal
      ) {
        throw new ConflictException(`Condition ${conditionId} is not available`);
      }
      return condition;
    }

    const conditions = await this.store.listConditions();
    const counts = new Map<string, number>();
    for (const condition of conditions) {
      counts.set(
        condition.id,
        await this.store.claimedCount(condition.id, round.id),
      );
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
    // Only current-round lobbies: a leftover waiting session from a previous
    // round must never be joined, or a group would mix rounds/settings.
    const round = await this.store.currentRound();
    return (await this.store
      .allSessions())
      .filter(
        (session) =>
          session.status === "waiting" &&
          session.roundId === round.id &&
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
    roundId: session.roundId,
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
