import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isTestCondition } from "@gdm/shared";
import type {
  CheckpointSessionRequest,
  CompleteParticipantResponse,
  Condition,
  ExportBundle,
  OpenSessionRequest,
  OpenSessionResponse,
  Participant,
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
  StudyInfoResponse,
  SubmitSurveyRequest,
} from "@gdm/shared";
import { MatrixService, type MatrixCreds } from "../matrix/matrix.service";
import { StoreService } from "../store/store.service";
import { checkpointFromSession } from "../store/checkpoint-merge";
import { waitingTimeoutMinutes } from "../store/waiting-timeout";
import {
  filterResearchPads,
  filterResearchSessions,
  type ResearchFilter,
} from "../reports/filter";
import { validateSurveyAnswers } from "../validation/request-validation";
import { ProlificActionsService } from "../prolific/prolific-actions.service";
import { prolificApiToken } from "../prolific/prolific-api";
import { EtherpadService } from "../etherpad/etherpad.service";
import {
  disconnectCompensationKind,
  partialPaymentPence,
  selfTerminationCompensationKind,
} from "./compensation";
import {
  defaultOutcomeReason,
  toOutcomeResponse,
} from "./participation-outcomes";
import {
  ProlificSubmissionVerifier,
  assertProlificIdentifiers,
} from "./prolific-verification";
import { toPublicSession } from "./public-session";
import { RoomProvisioner } from "./room-provisioning";
import {
  bundlePad,
  contributionRecords,
  contributionsCsv,
  interventionRows,
  interventionsCsv,
  messageRows,
  messagesCsv,
  sessionSettingsCsv,
  sessionsCsv,
  surveyRows,
  surveysCsv,
} from "./session-exports";

/** How often expired lobbies and disconnected participants are swept. */
const LIFECYCLE_SWEEP_INTERVAL_MS = 5_000;

/**
 * Participant journey and session lifecycle: matchmaking, Prolific
 * arrivals/outcomes, surveys, runtime checkpoints and lifecycle sweeps.
 *
 * Matrix room provisioning (RoomProvisioner), Prolific submission
 * verification, compensation rules and the legacy export rows live in
 * sibling modules.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SessionsService.name);
  /** URL the browser uses to reach Synapse (returned to the client). */
  private readonly publicUrl =
    process.env.MATRIX_PUBLIC_URL ?? "http://localhost:8008";
  /**
   * Waiting sessions older than this are considered abandoned (no-shows) and
   * are aborted so they stop counting against the condition goal. Prolific
   * participants receive a terminal unmatched outcome and are never requeued.
   */
  private readonly waitingTimeoutMinutes = waitingTimeoutMinutes();
  /** A closed or disconnected participant may resume until this grace expires. */
  private readonly reconnectGraceSeconds = Math.max(
    5,
    Number(process.env.PARTICIPANT_RECONNECT_GRACE_SECONDS ?? 30) || 30,
  );
  /** Avoid repeating the Prolific API lookup across arrival → resume → join. */
  private readonly prolificVerifier = new ProlificSubmissionVerifier(this.log);
  /** Serialize durable runtime writes per session without blocking other groups. */
  private readonly runtimeWriteChains = new Map<string, Promise<unknown>>();
  /** Matrix identities and room provisioning, single-flight per participant/session. */
  private readonly provisioner: RoomProvisioner;
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
    @Optional() private readonly etherpad?: EtherpadService,
  ) {
    this.provisioner = new RoomProvisioner(store, matrix, this.log, (id) =>
      this.getSession(id),
    );
  }

  onModuleInit(): void {
    this.lifecycleSweepTimer = setInterval(
      () => void this.runLifecycleSweep(),
      LIFECYCLE_SWEEP_INTERVAL_MS,
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
    await this.etherpad?.attach(req.trackingToken, seat.session, seat.participant.id);
    const creds = await this.provisioner.ensureParticipantAccess(
      seat.session,
      seat.participant,
    );
    const session = await this.getSession(seat.session.id);
    // The durable seat and credentials are enough to finish this request.
    // The waiting room polls while slow homeserver work continues, avoiding
    // enrollment timeouts during a recruitment wave.
    this.provisioner.provisionInBackgroundIfFull(session, "background provisioning");

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
    // Expired lobbies must free their condition slot before a seat is chosen.
    await this.sweepExpiredWaitingRooms();

    // A token that already holds a seat gets that seat back (browser refresh,
    // duplicate tab) instead of claiming a second slot and ghosting the first.
    const existing = req.prolific
      ? await this.findByProlificSession(req.prolific)
      : await this.store.findByTrackingToken(req.trackingToken);
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

    const taskMode = await this.etherpad?.modeFor(req.trackingToken);
    const forming = taskMode
      ? await this.store.findForming(req.conditionId, taskMode)
      : await this.store.findForming(req.conditionId);
    let condition = forming ? undefined : await this.assignCondition(req.conditionId);
    if (condition && taskMode) {
      condition = { ...condition, config: { ...condition.config, workspaceMode: taskMode } };
    }
    const session = forming ?? await this.store.createForming(condition!);

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
    const apiToken = prolificApiToken();
    assertProlificIdentifiers(identity, apiToken);

    const recorded = await this.store.getProlificArrival(identity);
    if (recorded && recorded.participantId !== identity.participantId) {
      throw new ConflictException(
        "This Prolific submission belongs to a different participant",
      );
    }

    if (!apiToken) return;
    await this.prolificVerifier.verify(identity, apiToken, allowEnded);
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
      const kind = selfTerminationCompensationKind(outcome, arrival.stage);
      const record = await this.store.terminateProlificParticipation(
        identity,
        outcome,
        reason || defaultOutcomeReason(outcome),
        kind,
      );

      if (existing) {
        await this.leaveSession(
          existing,
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
    const creds = await this.provisioner.ensureParticipantAccess(session, participant);
    const current = await this.getSession(session.id);
    this.provisioner.provisionInBackgroundIfFull(current, "background provisioning");
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
    // A prior provisioning attempt may have exhausted its retries. Waiting
    // Room polling safely re-triggers it without delaying the GET response.
    this.provisioner.provisionInBackgroundIfFull(session, "background provisioning retry");
    return toPublicSession(session);
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.store.listSessionSummaries();
  }

  async exportBundle(filter: ResearchFilter = {}): Promise<ExportBundle> {
    const sessions = await this.filteredSessions(filter);
    const pads = filterResearchPads(await this.etherpad?.documents() ?? [], sessions, filter)
      .map(bundlePad);
    return {
      generatedAt: new Date().toISOString(),
      sessions,
      ...(pads.length ? { etherpads: pads } : {}),
    };
  }

  /** Sessions restricted to the given conditions/rounds (empty = everything). */
  private async filteredSessions(filter: ResearchFilter = {}): Promise<Session[]> {
    return filterResearchSessions(await this.store.allSessions(), filter);
  }

  async exportCsv(filter: ResearchFilter = {}): Promise<string> {
    return sessionsCsv(await this.filteredSessions(filter));
  }

  /** Per-session settings snapshot (condition + intervention configuration). */
  async exportDetailedCsv(filter: ResearchFilter = {}): Promise<string> {
    return sessionSettingsCsv(await this.filteredSessions(filter));
  }

  /** Chat logs across sessions, one row per message. */
  async exportMessages(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      messages: messageRows(await this.filteredSessions(filter)),
    };
  }

  async exportMessagesCsv(filter: ResearchFilter = {}): Promise<string> {
    return messagesCsv((await this.exportMessages(filter)).messages);
  }

  /** Bot nudge events across sessions, one row per intervention. */
  async exportInterventions(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      interventions: interventionRows(await this.filteredSessions(filter)),
    };
  }

  async exportInterventionsCsv(filter: ResearchFilter = {}): Promise<string> {
    return interventionsCsv(
      (await this.exportInterventions(filter)).interventions,
    );
  }

  /** Survey responses across sessions, one row per participant and kind. */
  async exportSurveys(filter: ResearchFilter = {}) {
    return {
      generatedAt: new Date().toISOString(),
      surveys: surveyRows(await this.filteredSessions(filter)),
    };
  }

  async exportSurveysCsv(filter: ResearchFilter = {}): Promise<string> {
    return surveysCsv((await this.exportSurveys(filter)).surveys);
  }

  async exportContributions(filter: ResearchFilter = {}) {
    const sessions = await this.filteredSessions(filter);
    return {
      generatedAt: new Date().toISOString(),
      ...contributionRecords(sessions),
    };
  }

  async exportContributionsCsv(filter: ResearchFilter = {}): Promise<string> {
    return contributionsCsv(
      (await this.exportContributions(filter)).contributions,
    );
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
          `${lobby.id} (${lobby.participantCount} participant(s) after ` +
          `${this.waitingTimeoutMinutes}min)`,
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
        const compensationKind = disconnectCompensationKind(arrival.stage);
        const amountPence =
          compensationKind === "partial"
            ? partialPaymentPence(arrival.arrivedAt)
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
        const abortedRoom =
          existing &&
          (await this.leaveSession(
            existing,
            "The live group could not continue after a participant disconnected.",
          ))
            ? existing.session.roomId
            : undefined;
        if (existing && abortedRoom) {
          for (const participant of existing.session.participants) {
            if (!participant.matrixUserId) continue;
            try {
              await this.matrix.kick(
                abortedRoom,
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
      const amountPence = partialPaymentPence(
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

  private async outcomeResponse(
    record: ParticipationOutcomeRecord,
  ): Promise<ParticipationOutcomeResponse> {
    return toOutcomeResponse(record, await this.store.getStudySettings());
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
  ): Promise<StartSessionNotification[]> {
    if (!botUserId) throw new BadRequestException("botUserId is required");
    const running = await this.store.runningSessions();
    const notes: StartSessionNotification[] = [];
    for (const session of running) {
      try {
        // A freshly registered recovery bot must regain the redaction power
        // granted during initial room provisioning before moderation is used.
        await this.provisioner.grantBotAccess(session.roomId!, botUserId);
      } catch (error) {
        // The bot may already be invited/joined, or Synapse may be briefly
        // unavailable. Return this room regardless: the bot's authenticated
        // join is the authoritative check, and Chat Service retries failures
        // per room without preventing every later room from recovering.
        this.log.warn(
          `primary bot re-invite failed for ${session.id}: ${String(error)}`,
        );
      }
      notes.push({
        sessionId: session.id,
        roomId: session.roomId!,
        condition: session.condition,
        durationMinutes: session.durationMinutes,
        startedAt: session.startedAt,
        checkpoint: checkpointFromSession(session),
      });
    }
    return notes;
  }

  async submitSurvey(req: SubmitSurveyRequest): Promise<void> {
    const session = await this.getSession(req.sessionId);
    if (session.condition.config.workspaceMode === "etherpad") {
      const id = await this.etherpad?.surveyPadId(session.id, req.participantId, req.kind);
      if (!id) throw new ConflictException("Writing task not saved");
      const answers = { ...req.survey.answers };
      for (const key of ["individualRanking", "finalRanking", "finalRankingPartial", "finalRankingCompleted", "finalRankingTimedOut", "rankingCompleted", "rankingSecondsUsed", "exitRankingCompleted", "exitRankingSecondsUsed", "entryEtherpadId", "exitEtherpadId"]) delete answers[key];
      answers[req.kind === "entry" ? "entryEtherpadId" : "exitEtherpadId"] = id;
      req = { ...req, survey: { ...req.survey, answers } };
    }
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

    const candidate = (await this.recruitingConditions(round.id)).sort(
      (a, b) => a.claimed - b.claimed,
    )[0]?.condition;
    if (!candidate) throw new ConflictException("Study is full — no active condition needs participants");
    return candidate;
  }

  /** Active conditions still below their goal in the given round. */
  private async recruitingConditions(
    roundId: number,
  ): Promise<Array<{ condition: Condition; claimed: number }>> {
    const recruiting: Array<{ condition: Condition; claimed: number }> = [];
    for (const condition of await this.store.listConditions()) {
      const claimed = await this.store.claimedCount(condition.id, roundId);
      if (condition.active && claimed < condition.goal) {
        recruiting.push({ condition, claimed });
      }
    }
    return recruiting;
  }

  /**
   * Public study facts quoted before assignment: the given condition's, else
   * the value every recruiting study arm shares (null where they differ or
   * when no arm is recruiting).
   */
  async studyInfo(conditionId?: string): Promise<StudyInfoResponse> {
    const condition = conditionId
      ? await this.store.getCondition(conditionId)
      : undefined;
    if (condition) {
      return {
        groupSize: condition.groupSize,
        durationMinutes: condition.durationMinutes,
      };
    }
    const round = await this.store.currentRound();
    const recruiting = (await this.recruitingConditions(round.id))
      .map((item) => item.condition)
      .filter((item) => !isTestCondition(item.id));
    return {
      groupSize: sharedValue(recruiting.map((item) => item.groupSize)),
      durationMinutes: sharedValue(
        recruiting.map((item) => item.durationMinutes),
      ),
    };
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
   * A participant left for good: free their seat in a waiting lobby, or end
   * their live group (the others receive a dropout outcome). Returns true
   * when a provisioning/running group was aborted.
   */
  private async leaveSession(
    existing: { session: Session; participant: Participant },
    dropoutReason: string,
  ): Promise<boolean> {
    const { session, participant } = existing;
    if (session.status === "waiting") {
      await this.store.removeParticipantFromWaitingSession(
        session.id,
        participant.id,
      );
      return false;
    }
    if (session.status !== "provisioning" && session.status !== "running") {
      return false;
    }
    await this.store.updateSessionLifecycle(session.id, { status: "aborted" });
    await this.terminateSessionParticipants(
      session.id,
      "participant_dropout",
      dropoutReason,
    );
    return true;
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
}

/** The value every entry shares, or null when they differ (or none exist). */
function sharedValue(values: number[]): number | null {
  return values.length > 0 && values.every((value) => value === values[0])
    ? values[0]
    : null;
}
