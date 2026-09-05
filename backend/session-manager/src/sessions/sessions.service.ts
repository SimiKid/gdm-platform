import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_INTERVENTION_CONFIG,
  isServiceUser,
  normalizeInterventionMode,
} from "@gdm/shared";
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
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationOutcomeResponse,
  ParticipationStage,
  ProlificArrival,
  ProlificIdentity,
  ProlificResumeResponse,
  PublicSession,
  Session,
  SessionSummary,
  StartRoundResponse,
  StartSessionNotification,
  StudySettings,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService, type MatrixCreds } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";
import { toCsv } from "../reports/csv";
import {
  filterResearchSessions,
  type ResearchFilter,
} from "../reports/filter";
import { validateSurveyAnswers } from "../validation/request-validation";
import { ProlificActionsService } from "../prolific/prolific-actions.service";

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SessionsService.name);
  /** URL the browser uses to reach Synapse (returned to the client). */
  private readonly publicUrl =
    process.env.MATRIX_PUBLIC_URL ?? "http://localhost:8008";
  /** Chat Service that runs the live session (bot rules). */
  private readonly chatServiceUrl =
    process.env.CHAT_SERVICE_URL ?? "http://localhost:3002";
  /**
   * Waiting sessions older than this are considered abandoned (no-shows) and
   * are aborted so they stop counting against the condition goal. Prolific
   * participants receive a terminal unmatched outcome and are never requeued.
   */
  private readonly waitingTimeoutMinutes = Number(
    process.env.WAITING_TIMEOUT_MINUTES ?? 5,
  );
  /** A closed or disconnected participant may resume until this grace expires. */
  private readonly reconnectGraceSeconds = Math.max(
    5,
    Number(process.env.PARTICIPANT_RECONNECT_GRACE_SECONDS ?? 30) || 30,
  );
  /** Avoid repeating the Prolific API lookup across arrival → resume → join. */
  private readonly verifiedProlificSubmissions = new Map<string, number>();
  /** Serialize durable runtime writes per session without blocking other groups. */
  private readonly runtimeWriteChains = new Map<string, Promise<unknown>>();
  /** One Matrix credential operation per participant, including re-invites. */
  private readonly participantAccessChains = new Map<
    string,
    Promise<MatrixCreds>
  >();
  /** At most one room-provisioning attempt per forming session. */
  private readonly provisionChains = new Map<string, Promise<Session>>();
  private lifecycleSweepTimer?: ReturnType<typeof setInterval>;
  private lifecycleSweepRunning = false;

  /**
   * Joins must not interleave: find-or-create of the forming session races
   * otherwise, and simultaneous joiners each open their own group that then
   * never fills. In-process serialization suffices for a single instance.
   */
  private matchmakingChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: StoreService,
    private readonly matrix: MatrixService,
    private readonly prolificActions: ProlificActionsService,
  ) {}

  onModuleInit(): void {
    this.lifecycleSweepTimer = setInterval(
      () => void this.runLifecycleSweep(),
      5_000,
    );
    this.lifecycleSweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.lifecycleSweepTimer) clearInterval(this.lifecycleSweepTimer);
  }

  private async runLifecycleSweep(): Promise<void> {
    if (this.lifecycleSweepRunning) return;
    this.lifecycleSweepRunning = true;
    try {
      await this.sweepExpiredWaitingRooms();
      await this.sweepDisconnectedParticipants();
    } catch (error) {
      this.log.error(`participant lifecycle sweep failed: ${String(error)}`);
    } finally {
      this.lifecycleSweepRunning = false;
    }
  }

  /**
   * Waiting-Room entry: place the participant into a forming group, register
   * their Matrix user, and — once the group is full — provision the room and
   * flip the session to "running".
   */
  async openSession(req: OpenSessionRequest): Promise<OpenSessionResponse> {
    // External validation and Matrix provisioning must never occupy the global
    // seat-assignment lock. Only the short find-or-create/add-seat section is
    // serialized, preventing duplicate lobbies without queueing network I/O.
    await this.validateProlificIdentity(req.prolific);
    if (req.prolific) {
      const outcome = await this.store.getParticipationOutcome(req.prolific);
      if (outcome?.outcome) {
        throw new ConflictException("This Prolific participation has ended");
      }
      await this.store.recordParticipationStage(req.prolific, "waiting");
    }

    const seat = await this.queueMatchmaking(() => this.reserveSeat(req));
    const creds = await this.ensureParticipantAccess(
      seat.session,
      seat.participant,
    );
    const session = await this.getSession(seat.session.id);
    if (
      (session.status === "waiting" || session.status === "provisioning") &&
      session.participants.length >= session.condition.groupSize
    ) {
      // The durable seat and credentials are enough to finish this request.
      // The waiting room polls while slow homeserver work continues, avoiding
      // enrollment timeouts during a recruitment wave.
      void this.ensureProvisioned(session.id).catch((error) =>
        this.log.warn(
          `background provisioning failed for ${session.id}: ${String(error)}`,
        ),
      );
    }

    this.log.log(
      `openSession: ${seat.existing ? "rejoin " : ""}${seat.participant.id} -> ` +
        `${session.condition.name} (${session.participants.length}/` +
        `${session.condition.groupSize}) ${session.status}`,
    );
    return this.openResponse(session, seat.participant, creds);
  }

  /**
   * Close the current study round and open the next one. Rides the same
   * serialization chain as joins, so a round switch can never interleave
   * with a participant entering a lobby: the joiner either lands in the old
   * round before its lobbies are aborted, or opens a fresh current-round
   * session afterwards.
   */
  startRound(label?: string): Promise<StartRoundResponse> {
    return this.queueMatchmaking(() => this.doStartRound(label ?? ""));
  }

  private async doStartRound(label: string): Promise<StartRoundResponse> {
    // Abort leftover lobbies so no group mixes participants across rounds.
    // Prolific participants in those lobbies receive a terminal group-aborted
    // outcome. Running sessions finish in their original round.
    const waiting = await this.store.abortWaitingSessions();
    for (const lobby of waiting) {
      await this.terminateSessionParticipants(
        lobby.id,
        "group_aborted",
        "The waiting lobby closed when the researcher started a new round.",
      );
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

  private async reserveSeat(req: OpenSessionRequest): Promise<{
    session: Session;
    participant: Participant;
    existing: boolean;
  }> {
    await this.abortStaleWaiting();

    // A token that already holds a seat gets that seat back (browser refresh,
    // duplicate tab) instead of claiming a second slot and ghosting the first.
    const existing = req.prolific
      ? await this.findByProlificSession(req.prolific)
      : await this.findByTrackingToken(req.trackingToken);
    if (existing) {
      if (existing.session.status === "aborted" && req.prolific) {
        throw new ConflictException("This waiting attempt has ended");
      }
      if (req.prolific) {
        await this.store.linkProlificArrival(
          req.prolific,
          existing.participant.id,
        );
      }
      return { ...existing, existing: true };
    }

    const session =
      (await this.findForming(req.conditionId)) ??
      (await this.store.createForming(await this.assignCondition(req.conditionId)));

    const participant: Participant = {
      id: randomUUID(),
      name: req.participantName,
      trackingToken: req.trackingToken,
      recruitmentSource: req.prolific ? "prolific" : "direct",
      prolific: req.prolific,
    };
    session.participants.push(participant);
    await this.store.addParticipant(session.id, participant);
    if (req.prolific) {
      await this.store.linkProlificArrival(req.prolific, participant.id);
    }

    return { session, participant, existing: false };
  }

  /** Mark abandoned waiting groups aborted so they free their condition slot. */
  private async abortStaleWaiting(): Promise<void> {
    const stale = await this.store.abortExpiredWaitingSessions();
    for (const session of stale) {
      const provisioningFailed = session.priorStatus === "provisioning";
      await this.terminateSessionParticipants(
        session.id,
        provisioningFailed ? "technical_failure" : "unmatched",
        provisioningFailed
          ? "The complete group could not enter the chat because room provisioning did not finish before the deadline."
          : "The required live group did not form before the waiting deadline.",
      );
      this.log.log(
        `aborted stale waiting session ${session.id} ` +
          `(${session.participantCount} participant(s) after ${this.waitingTimeoutMinutes}min)`,
      );
    }
  }

  /** The non-aborted session already holding this tracking token, if any. */
  private async findByTrackingToken(
    token: string,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    return this.store.findByTrackingToken(token);
  }

  /** Find the exact Prolific submission even if the client token changes. */
  private async findByProlificSession(
    identity: ProlificIdentity,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    const existing = await this.store.findByProlificSession(identity);
    if (
      existing &&
      existing.participant.prolific?.participantId !== identity.participantId
    ) {
      throw new ConflictException(
        "This Prolific submission belongs to a different participant",
      );
    }
    return existing;
  }

  /** Validate URL identifiers and, when configured, their Prolific submission. */
  private async validateProlificIdentity(
    identity?: ProlificIdentity,
    allowEnded = false,
  ): Promise<void> {
    if (!identity) return;
    const apiToken = process.env.PROLIFIC_API_TOKEN?.trim();
    // Prolific identifiers are 24 alphanumeric characters. They are not
    // guaranteed to be hexadecimal, particularly in participant previews.
    const idPattern = /^[a-z0-9]{24}$/i;
    // Prolific's researcher preview uses shorter synthetic submission IDs whose
    // length can vary. Accept those only while API-backed validation is off;
    // secure validation still requires the real 24-character submission ID.
    const previewSessionIdPattern = /^[a-z0-9]{12,23}$/i;
    const validSessionId =
      idPattern.test(identity.sessionId) ||
      (!apiToken && previewSessionIdPattern.test(identity.sessionId));
    if (
      !idPattern.test(identity.participantId) ||
      !idPattern.test(identity.studyId) ||
      !validSessionId
    ) {
      throw new BadRequestException("Invalid Prolific identifiers");
    }
    const expectedStudyId = process.env.PROLIFIC_STUDY_ID?.trim();
    if (expectedStudyId && identity.studyId !== expectedStudyId) {
      throw new BadRequestException("Unexpected Prolific study");
    }

    const recorded = await this.store.getProlificArrival(identity);
    if (recorded && recorded.participantId !== identity.participantId) {
      throw new ConflictException(
        "This Prolific submission belongs to a different participant",
      );
    }

    if (!apiToken) return;

    const cacheKey = [
      identity.studyId,
      identity.sessionId,
      identity.participantId,
    ].join(":");
    const cachedUntil = this.verifiedProlificSubmissions.get(cacheKey) ?? 0;
    if (cachedUntil > Date.now()) return;
    this.pruneProlificVerificationCache();

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
    const allowedStatuses = [
      "RESERVED",
      "ACTIVE",
      "AWAITING_REVIEW",
      "APPROVED",
      ...(allowEnded
        ? ["RETURNED", "TIMED_OUT", "SCREENED_OUT", "REJECTED"]
        : []),
    ];
    if (submissionStatus && !allowedStatuses.includes(submissionStatus)) {
      throw new BadRequestException(
        `Prolific submission is ${submissionStatus.toLowerCase()}`,
      );
    }

    this.verifiedProlificSubmissions.set(cacheKey, Date.now() + 60_000);
  }

  /** Keep attacker-controlled identifiers from growing the verification cache forever. */
  private pruneProlificVerificationCache(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.verifiedProlificSubmissions) {
      if (expiresAt <= now) this.verifiedProlificSubmissions.delete(key);
    }
    while (this.verifiedProlificSubmissions.size >= 5_000) {
      const oldest = this.verifiedProlificSubmissions.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.verifiedProlificSubmissions.delete(oldest);
    }
  }

  async recordProlificArrival(
    identity: ProlificIdentity,
  ): Promise<ProlificArrival> {
    await this.validateProlificIdentity(identity);
    return this.store.recordProlificArrival(identity);
  }

  async recordParticipationProgress(
    identity: ProlificIdentity,
    stage: Exclude<ParticipationStage, "done" | "terminated">,
  ): Promise<ProlificArrival> {
    await this.validateProlificIdentity(identity);
    return this.store.recordParticipationStage(identity, stage);
  }

  async terminateParticipation(
    identity: ProlificIdentity,
    outcome: "declined_consent" | "ineligible" | "voluntary_withdrawal",
    reason = "",
  ): Promise<ParticipationOutcomeResponse> {
    await this.validateProlificIdentity(identity);
    return this.queueMatchmaking(async () => {
      const arrival = await this.store.recordProlificArrival(identity);
      const existing = await this.findByProlificSession(identity);
      const kind =
        outcome === "voluntary_withdrawal" &&
        ["entry", "waiting", "chat", "exit"].includes(arrival.stage)
          ? "manual_review"
          : "none";
      const record = await this.store.terminateProlificParticipation(
        identity,
        outcome,
        reason || defaultOutcomeReason(outcome),
        kind,
      );

      if (existing?.session.status === "waiting") {
        await this.store.removeParticipantFromWaitingSession(
          existing.session.id,
          existing.participant.id,
        );
      } else if (
        existing &&
        ["provisioning", "running"].includes(existing.session.status)
      ) {
        await this.store.updateSessionLifecycle(existing.session.id, {
          status: "aborted",
        });
        await this.terminateSessionParticipants(
          existing.session.id,
          "participant_dropout",
          "The live group could not continue after a participant left.",
        );
      }

      return this.outcomeResponse(record);
    });
  }

  async getParticipationOutcome(
    identity: ProlificIdentity,
  ): Promise<ParticipationOutcomeResponse | null> {
    await this.validateProlificIdentity(identity, true);
    const record = await this.store.getParticipationOutcome(identity);
    return record?.outcome ? this.outcomeResponse(record) : null;
  }

  /** Restore a Prolific submission after the original browser tab was closed. */
  async resumeProlific(
    identity: ProlificIdentity,
  ): Promise<ProlificResumeResponse | null> {
    await this.validateProlificIdentity(identity, true);
    const terminal = await this.store.getParticipationOutcome(identity);
    if (terminal?.outcome && terminal.outcome !== "completed") {
      return {
        stage: "terminated",
        termination: await this.outcomeResponse(terminal),
      };
    }
    const existing = await this.findByProlificSession(identity);
    if (!existing) return null;

    if (existing.session.status === "aborted") return null;

    const openSession = await this.rejoinResponse(
      existing.session,
      existing.participant,
    );
    const stage =
      existing.participant.completedAt || existing.participant.exitSurvey
        ? "done"
        : openSession.session.status === "completed"
          ? "exit"
          : openSession.session.roomId
            ? "chat"
            : "waiting";
    return { stage, openSession };
  }

  /** Hand a returning participant their existing seat and credentials. */
  private async rejoinResponse(
    session: Session,
    participant: Participant,
  ): Promise<OpenSessionResponse> {
    const creds = await this.ensureParticipantAccess(session, participant);
    const current = await this.getSession(session.id);
    if (
      (current.status === "waiting" || current.status === "provisioning") &&
      current.participants.length >= current.condition.groupSize
    ) {
      void this.ensureProvisioned(current.id).catch((error) =>
        this.log.warn(
          `background provisioning failed for ${current.id}: ${String(error)}`,
        ),
      );
    }
    this.log.log(
      `openSession: rejoin ${participant.id} -> session ${session.id} (${current.status})`,
    );
    return this.openResponse(current, participant, creds);
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
    const session = await this.getSession(id);
    if (
      (session.status === "waiting" || session.status === "provisioning") &&
      session.participants.length >= session.condition.groupSize
    ) {
      // A prior provisioning attempt may have exhausted its retries. Waiting
      // Room polling safely re-triggers it without delaying the GET response.
      void this.ensureProvisioned(id).catch((error) =>
        this.log.warn(`background provisioning retry failed for ${id}: ${String(error)}`),
      );
    }
    return toPublicSession(session);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.store.listSessionSummaries();
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

  /**
   * Per-session settings snapshot for researcher analysis: one row per session
   * carrying its condition and intervention configuration. Standard CSV format
   * (dot decimals, comma-delimited), consistent with the other exports.
   */
  async exportDetailedCsv(filter: ResearchFilter = {}): Promise<string> {
    const sessions = (await this.exportBundle(filter)).sessions;
    const rows = [
      [
        "session_id",
        "status",
        "round_id",
        "condition_id",
        "condition_name",
        "goal",
        "group_size",
        "duration_minutes",
        "llm_mode",
        "workspace_mode",
        "comparison_mode",
        "intervention_mode",
        "invite_grace_seconds",
        "protected_start_minutes",
        "protected_end_minutes",
        "contribution_threshold",
        "contribution_window_minutes",
        "score_weight_words",
        "score_weight_messages",
        "dominance_weight_share",
        "dominance_weight_meaningfulness",
        "final_group_ranking",
        "room_id",
        "created_at",
        "started_at",
        "completed_at",
      ],
      ...sessions.map((session) => {
        // Old sessions may predate some config keys; merge defaults so every
        // column is populated.
        const config = {
          ...DEFAULT_INTERVENTION_CONFIG,
          ...session.condition.config,
        };
        const scoreWeights = {
          ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
          ...config.scoreWeights,
        };
        const dominanceWeights = {
          ...DEFAULT_INTERVENTION_CONFIG.dominanceWeights,
          ...config.dominanceWeights,
        };
        return [
          session.id,
          session.status,
          String(session.roundId),
          session.condition.id,
          session.condition.name,
          String(session.condition.goal),
          String(session.condition.groupSize),
          String(session.durationMinutes),
          config.llmMode ?? "off",
          config.workspaceMode === "external" ? "external" : "ranking",
          config.comparisonMode ? "TRUE" : "FALSE",
          // Fold retired tone suffixes (e.g. "public-neutral") onto the
          // canonical baseline/public/private axis, matching the stored type.
          normalizeInterventionMode(config.interventionMode),
          String(config.inviteGraceSeconds),
          String(config.protectedStartMinutes),
          String(config.protectedEndMinutes),
          String(config.contributionThreshold),
          String(config.contributionWindowMinutes),
          String(scoreWeights.words),
          String(scoreWeights.messages),
          String(dominanceWeights.share),
          String(dominanceWeights.meaningfulness),
          session.ranking.order.join("|"),
          session.roomId ?? "",
          session.createdAt,
          session.startedAt ?? "",
          session.completedAt ?? "",
        ];
      }),
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
          roundId: session.roundId,
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
        "round",
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
        String(m.roundId),
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
            roundId: session.roundId,
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
        "round",
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
        String(i.roundId),
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
              roundId: session.roundId,
              participantId: participant.id,
              participantName: participant.name,
              trackingToken: participant.trackingToken,
              recruitmentSource: participant.recruitmentSource,
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
        "round",
        "participant_id",
        "participant_name",
        "tracking_token",
        "recruitment_source",
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
        String(s.roundId),
        s.participantId,
        s.participantName,
        s.trackingToken,
        s.recruitmentSource,
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
          roundId: session.roundId,
          ...event,
        })),
      ),
      classifications: sessions.flatMap((session) =>
        session.contributionClassifications.map((classification) => ({
          sessionId: session.id,
          conditionId: session.condition.id,
          roundId: session.roundId,
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
        "round",
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
        String(c.roundId),
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
      const completedAt = new Date().toISOString();
      await this.store.updateSessionLifecycle(id, {
        status: "completed",
        completedAt,
      });
      session.status = "completed";
      session.completedAt = completedAt;
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
    if (participant.prolific) {
      const outcome = await this.store.getParticipationOutcome(
        participant.prolific,
      );
      if (outcome?.outcome && outcome.outcome !== "completed") {
        throw new ConflictException("This participation has already ended");
      }
    }
    if (!participant.completedAt) {
      const completedAt = new Date().toISOString();
      await this.store.markParticipantCompleted(
        sessionId,
        participantId,
        completedAt,
      );
      participant.completedAt = completedAt;
      this.log.log(
        `participant ${participant.id} completed session ${session.id}`,
      );
    }
    if (participant.prolific) {
      await this.store.completeProlificParticipation(participant.prolific);
    }
    const settings = await this.store.getStudySettings();
    return {
      completedAt: participant.completedAt,
      compensationUrl: participant.prolific ? settings.compensationUrl : "",
      recruitmentSource: participant.recruitmentSource,
    };
  }

  /** Public for deterministic tests; the timer invokes the same idempotent path. */
  async sweepExpiredWaitingRooms(): Promise<number> {
    const expired = await this.store.abortExpiredWaitingSessions();
    for (const lobby of expired) {
      const provisioningFailed = lobby.priorStatus === "provisioning";
      await this.terminateSessionParticipants(
        lobby.id,
        provisioningFailed ? "technical_failure" : "unmatched",
        provisioningFailed
          ? "The complete group could not enter the chat because room provisioning did not finish before the deadline."
          : "The required live group did not form before the waiting deadline.",
      );
      this.log.log(
        `terminated ${provisioningFailed ? "failed provisioning" : "unmatched"} lobby ` +
          `${lobby.id} (${lobby.participantCount} participant(s))`,
      );
    }
    return expired.length;
  }

  /**
   * Terminalize participants who stopped heartbeating, release their seat (or
   * abort their live group), and optionally tell Prolific to request a return.
   * The store rechecks the cutoff atomically so a reconnect wins any scan race.
   */
  async sweepDisconnectedParticipants(): Promise<number> {
    const cutoff = new Date(Date.now() - this.reconnectGraceSeconds * 1_000);
    const terminated = await this.queueMatchmaking(async () => {
      const claimed: ParticipationOutcomeRecord[] = [];
      for (const arrival of await this.store.listStaleProlificArrivals(cutoff)) {
        const compensationKind = ["waiting", "chat", "exit"].includes(
          arrival.stage,
        )
          ? "partial"
          : arrival.stage === "entry"
            ? "manual_review"
            : "none";
        const amountPence =
          compensationKind === "partial"
            ? this.partialPaymentPence(arrival.arrivedAt)
            : undefined;
        const record = await this.store.terminateStaleProlificParticipation(
          arrival,
          cutoff,
          "connection_timeout",
          `No participant heartbeat was received for ${this.reconnectGraceSeconds} seconds.`,
          compensationKind,
          amountPence,
        );
        if (!record) continue;

        const existing = await this.findByProlificSession(arrival);
        if (existing?.session.status === "waiting") {
          await this.store.removeParticipantFromWaitingSession(
            existing.session.id,
            existing.participant.id,
          );
        } else if (
          existing &&
          ["provisioning", "running"].includes(existing.session.status)
        ) {
          await this.store.updateSessionLifecycle(existing.session.id, {
            status: "aborted",
          });
          await this.terminateSessionParticipants(
            existing.session.id,
            "participant_dropout",
            "The live group could not continue after a participant disconnected.",
          );
          if (existing.session.roomId) {
            for (const participant of existing.session.participants) {
              if (!participant.matrixUserId) continue;
              try {
                await this.matrix.kick(
                  existing.session.roomId,
                  participant.matrixUserId,
                  "The study group ended after a participant disconnected.",
                );
              } catch (error) {
                this.log.error(
                  `could not remove ${participant.matrixUserId} from aborted room: ${String(error)}`,
                );
              }
            }
          }
        }
        claimed.push(record);
        this.log.log(
          `terminated disconnected Prolific submission ${record.sessionId} after ` +
            `${this.reconnectGraceSeconds}s grace`,
        );
      }
      return claimed;
    });

    if (process.env.PROLIFIC_AUTO_RETURN_DISCONNECTS === "true") {
      for (const record of terminated) {
        try {
          await this.prolificActions.requestReturnAndRecordFailureById(record.id);
        } catch (error) {
          this.log.warn(
            `could not request Prolific return for ${record.sessionId}: ${String(error)}`,
          );
        }
      }
    }
    return terminated.length;
  }

  private async terminateSessionParticipants(
    sessionId: string,
    outcome: "unmatched" | "technical_failure" | "participant_dropout" | "group_aborted",
    reason: string,
  ): Promise<void> {
    const session = await this.getSession(sessionId);
    for (const participant of session.participants) {
      if (!participant.prolific) continue;
      const arrival = await this.store.getProlificArrival(participant.prolific);
      if (arrival?.outcome) continue;
      const amountPence = this.partialPaymentPence(
        arrival?.arrivedAt ?? session.createdAt,
      );
      await this.store.terminateProlificParticipation(
        participant.prolific,
        outcome,
        reason,
        "partial",
        amountPence,
      );
    }
  }

  private partialPaymentPence(startedAt: string): number {
    const elapsedSeconds = Math.max(
      1,
      Math.floor((Date.now() - Date.parse(startedAt)) / 1_000),
    );
    const pencePerMinute = Math.max(
      10,
      Number(process.env.PARTIAL_PAYMENT_PENCE_PER_MINUTE ?? 10) || 10,
    );
    const maximumPence = Math.max(
      10,
      Number(process.env.PARTIAL_PAYMENT_MAX_PENCE ?? 508) || 508,
    );
    return Math.min(
      maximumPence,
      Math.max(10, Math.ceil(elapsedSeconds / 60) * pencePerMinute),
    );
  }

  private async outcomeResponse(
    record: ParticipationOutcomeRecord,
  ): Promise<ParticipationOutcomeResponse> {
    const settings = await this.store.getStudySettings();
    const outcome = record.outcome!;
    const redirectUrl = outcomeUrl(settings, outcome);
    return {
      outcome,
      compensationKind: record.compensationKind,
      compensationAmountPence: record.compensationAmountPence,
      redirectUrl,
      message: outcomeMessage(record),
    };
  }

  /** Persist live state without changing the session lifecycle. */
  async checkpointSession(
    id: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<void> {
    await this.queueRuntimeWrite(id, () =>
      this.store.saveRuntimeCheckpoint(id, checkpoint),
    );
  }

  /** Persist the discussion returned by the Chat Service at session end. */
  async finalizeSession(
    id: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<Session> {
    await this.queueRuntimeWrite(id, async () => {
      await this.store.saveRuntimeCheckpoint(id, checkpoint);
      const current = await this.getSession(id);
      if (current.status !== "aborted") {
        await this.store.updateSessionLifecycle(id, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
      }
    });
    const session = await this.getSession(id);
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
    const running = await this.store.runningSessions();
    const notes: StartSessionNotification[] = [];
    for (const session of running) {
      try {
        await this.matrix.invite(session.roomId!, botUserId);
        // A freshly registered recovery bot must regain the redaction power
        // granted during initial room provisioning before moderation is used.
        await this.matrix.setUserPowerLevel(session.roomId!, botUserId, 50);
      } catch (error) {
        // The bot may already be invited/joined, or Synapse may be briefly
        // unavailable. Return this room regardless: the bot's authenticated
        // join is the authoritative check, and Chat Service retries failures
        // per room without preventing every later room from recovering.
        this.log.warn(
          `primary bot re-invite failed for ${session.id}: ${String(error)}`,
        );
      }
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
          revision: session.checkpointRevision,
          messages: session.chat.messages,
          rankingHistory: session.rankingHistory ?? [],
          interventions: session.interventions,
          behavioralEvents: session.behavioralEvents,
          contributionClassifications: session.contributionClassifications,
          windowEvaluations: session.windowEvaluations ?? [],
          classificationFailures: session.classificationFailures ?? [],
          processedEventIds: session.processedEventIds ?? [],
          redactedReactionEventIds:
            session.redactedReactionEventIds ?? [],
          reactionEvents: session.reactionEvents ?? [],
          ruleState: session.runtimeState ?? {},
        },
      });
    }
    return notes;
  }

  async submitSurvey(req: SubmitSurveyRequest): Promise<void> {
    const session = await this.getSession(req.sessionId);
    validateSurveyAnswers(
      req,
      session.rankingTask.items.map((item) => item.id),
    );
    const saved = await this.store.saveParticipantSurvey(
      req.sessionId,
      req.participantId,
      req.kind,
      req.survey,
    );
    if (!saved) {
      throw new NotFoundException(`Unknown participant ${req.participantId}`);
    }
  }

  async submitDebriefFeedback(
    sessionId: string,
    participantId: string,
    feedback: string,
  ): Promise<void> {
    const patched = await this.store.patchExitSurveyAnswers(
      sessionId,
      participantId,
      { debriefFeedback: feedback },
    );
    if (!patched) {
      throw new NotFoundException(`Unknown participant or missing exit survey`);
    }
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
    return this.store.findForming(conditionId);
  }

  /** Serialize only the short database matchmaking critical section. */
  private queueMatchmaking<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.matchmakingChain.catch(() => undefined).then(operation);
    this.matchmakingChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Ensure one durable Matrix identity per participant. A failed registration
   * leaves the reserved seat intact; a retry resumes it instead of duplicating
   * the participant or losing their survey linkage.
   */
  private ensureParticipantAccess(
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

  private openResponse(
    session: Session,
    participant: Participant,
    creds: MatrixCreds,
  ): OpenSessionResponse {
    return {
      session: toPublicSession(session),
      participantId: participant.id,
      matrix: {
        homeserverUrl: this.publicUrl,
        userId: creds.userId,
        accessToken: creds.accessToken,
        // During provisioning roomId is an internal recovery handle. Only
        // publish it after every member and the recorder bot are ready.
        roomId: session.status === "running" ? (session.roomId ?? "") : "",
      },
    };
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
    // Comparison conditions additionally need Assistant A/B invited: rooms
    // are invite-only, so an uninvited bot's join is rejected with 403.
    const bot = await this.fetchBotIdentity();
    if (bot.userId) {
      try {
        await this.matrix.invite(roomId, bot.userId);
        // Grant redaction rights so the bot can moderate abusive messages.
        await this.matrix.setUserPowerLevel(roomId, bot.userId, 50);
      } catch (error) {
        // On a retry the primary bot may already be invited or joined. The
        // idempotent Chat Service start below is the authoritative check.
        this.log.warn(`primary bot invite retry failed: ${String(error)}`);
      }
    }
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

  /**
   * Preserve checkpoint/finalize order for one session while allowing all
   * other groups to persist independently. A rejected write is removed from
   * the chain so a later retry can recover normally.
   */
  private queueRuntimeWrite<T>(id: string, write: () => Promise<T>): Promise<T> {
    const previous = this.runtimeWriteChains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(write);
    const cleanup = () => {
      if (this.runtimeWriteChains.get(id) === tracked) {
        this.runtimeWriteChains.delete(id);
      }
    };
    // The tracked chain must never reject: callers observe `run`, while the
    // map only sequences later writes and performs cleanup.
    const tracked = run.then(cleanup, cleanup);
    this.runtimeWriteChains.set(id, tracked);
    return run;
  }

  /** Ask the Chat Service which Matrix users its bots run as. */
  private async fetchBotIdentity(): Promise<{
    userId?: string;
    comparisonUserIds: string[];
  }> {
    try {
      const res = await fetch(`${this.chatServiceUrl}/internal/bot`, {
        headers: internalHeaders(),
        signal: AbortSignal.timeout(5000),
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
    const res = await fetch(`${this.chatServiceUrl}/internal/sessions/start`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`chat service start failed (${res.status})`);
  }
}

function defaultOutcomeReason(outcome: ParticipationOutcome): string {
  switch (outcome) {
    case "declined_consent":
      return "The participant did not consent to take part.";
    case "ineligible":
      return "The participant did not meet the study eligibility requirements.";
    case "voluntary_withdrawal":
      return "The participant chose to withdraw from the study.";
    case "connection_timeout":
      return "The participant did not reconnect within the allowed grace period.";
    default:
      return "The participation ended before full completion.";
  }
}

function outcomeUrl(
  settings: StudySettings,
  outcome: ParticipationOutcome,
): string {
  switch (outcome) {
    case "declined_consent":
      return settings.noConsentUrl;
    case "ineligible":
      return settings.ineligibleUrl;
    case "voluntary_withdrawal":
      return settings.withdrawalUrl;
    case "connection_timeout":
      return settings.technicalFailureUrl || settings.withdrawalUrl;
    case "unmatched":
      return settings.unmatchedUrl;
    case "technical_failure":
    case "participant_dropout":
    case "group_aborted":
      return settings.technicalFailureUrl || settings.unmatchedUrl;
    case "completed":
      return settings.compensationUrl;
  }
}

function outcomeMessage(record: ParticipationOutcomeRecord): string {
  switch (record.outcome) {
    case "declined_consent":
      return "You have not entered the study. Please return your submission on Prolific.";
    case "ineligible":
      return "You cannot continue with this study. Please follow the return instructions.";
    case "voluntary_withdrawal":
      return record.compensationKind === "manual_review"
        ? "Your withdrawal was recorded. The researcher will review the time you spent."
        : "Your withdrawal was recorded. Please return your submission on Prolific.";
    case "connection_timeout":
      return record.compensationKind === "partial"
        ? "Your connection was lost and the reconnect window expired. Your partial payment has been queued for review."
        : "Your connection was lost and the reconnect window expired. Please follow the Prolific return instructions.";
    case "unmatched":
      return "A complete group could not be formed. Your partial payment has been queued for review.";
    case "technical_failure":
    case "group_aborted":
      return "The study could not continue. Your partial payment has been queued for review.";
    case "participant_dropout":
      return "Your participation ended before the group task finished. The researcher will review compensation.";
    case "completed":
      return "Your participation is complete.";
    default:
      return "Your participation has ended.";
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
      roundId: session.roundId,
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
    redactedReactionEventIds: _redactedReactionEventIds,
    reactionEvents: _reactionEvents,
    runtimeState: _runtimeState,
    checkpointRevision: _checkpointRevision,
    ...publicFields
  } = session;
  return {
    ...publicFields,
    // A room persisted mid-provisioning is recovery metadata, not an
    // invitation to enter a half-configured room.
    roomId: session.status === "provisioning" ? undefined : session.roomId,
    participants: session.participants.map((p) => ({ id: p.id, name: p.name })),
  };
}
