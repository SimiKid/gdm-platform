import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type {
  ConditionProgress,
  CheckpointSessionRequest,
  FinalizeSessionRequest,
  RecoverSessionsRequest,
  OpenSessionRequest,
  OpenSessionResponse,
  RecordParticipationProgressRequest,
  PublicSession,
  RecordProlificArrivalRequest,
  Session,
  SessionSummary,
  StudySettings,
  SubmitSurveyRequest,
  TerminateParticipationRequest,
  UpdateStudySettingsRequest,
  UpsertConditionRequest,
} from "@gdm/shared";
import { SessionsService } from "./sessions.service";
import { StoreService } from "../store/store.service";
import { AdminGuard } from "../auth/admin.guard";
import { InternalGuard } from "../auth/internal.guard";
import { ParticipantGuard } from "../auth/participant.guard";
import { ProlificActionsService } from "../prolific/prolific-actions.service";
import { parseConditionIds, parseRoundIds } from "../reports/filter";
import {
  validateCompensationUrl,
  validateCondition,
  validateOpenSessionRequest,
  validateParticipationProgressRequest,
  validateProlificArrivalRequest,
  validateSurveyRequest,
  validateTerminateParticipationRequest,
} from "../validation/request-validation";

@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly store: StoreService,
    private readonly prolificActions: ProlificActionsService,
  ) {}

  @Post("sessions")
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  openSession(@Body() body: OpenSessionRequest): Promise<OpenSessionResponse> {
    validateOpenSessionRequest(body);
    return this.sessions.openSession(body);
  }

  /** Capture Prolific identity immediately when the external study opens. */
  @Post("prolific/arrivals")
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  recordProlificArrival(@Body() body: RecordProlificArrivalRequest) {
    validateProlificArrivalRequest(body);
    return this.sessions.recordProlificArrival(body.prolific);
  }

  /** Resume the existing seat/stage after a Prolific participant reconnects. */
  @Post("prolific/resume")
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  resumeProlific(@Body() body: RecordProlificArrivalRequest) {
    validateProlificArrivalRequest(body);
    return this.sessions.resumeProlific(body.prolific);
  }

  @Post("prolific/progress")
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  participationProgress(@Body() body: RecordParticipationProgressRequest) {
    validateParticipationProgressRequest(body);
    return this.sessions.recordParticipationProgress(body.prolific, body.stage);
  }

  @Post("prolific/terminate")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  terminateParticipation(@Body() body: TerminateParticipationRequest) {
    validateTerminateParticipationRequest(body);
    return this.sessions.terminateParticipation(
      body.prolific,
      body.outcome,
      body.reason,
    );
  }

  @Post("prolific/outcome")
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  participationOutcome(@Body() body: RecordProlificArrivalRequest) {
    validateProlificArrivalRequest(body);
    return this.sessions.getParticipationOutcome(body.prolific);
  }

  /** Admin: list all sessions. */
  @Get("sessions")
  @UseGuards(AdminGuard)
  listSessions(): Promise<SessionSummary[]> {
    return this.sessions.listSessions();
  }

  /**
   * Waiting Room polls this for the live count and the roomId once ready.
   * Participant-facing: tracking tokens and survey answers are stripped.
   */
  @Get("sessions/:id")
  @UseGuards(ParticipantGuard)
  getSession(@Param("id") id: string): Promise<PublicSession> {
    return this.sessions.getPublicSession(id);
  }

  /** Admin: one session with full participant data (tokens, surveys). */
  @Get("admin/sessions/:id")
  @UseGuards(AdminGuard)
  getSessionFull(@Param("id") id: string): Promise<Session> {
    return this.sessions.getSession(id);
  }

  @Post("surveys")
  @UseGuards(ParticipantGuard)
  async submitSurvey(@Body() body: SubmitSurveyRequest): Promise<{ ok: true }> {
    validateSurveyRequest(body);
    await this.sessions.submitSurvey(body);
    return { ok: true };
  }

  @Post("surveys/debrief-feedback")
  @UseGuards(ParticipantGuard)
  async submitDebriefFeedback(
    @Body() body: { sessionId: string; participantId: string; feedback: string },
  ): Promise<{ ok: true }> {
    const feedback =
      typeof body.feedback === "string" ? body.feedback.slice(0, 4_000) : "";
    await this.sessions.submitDebriefFeedback(
      body.sessionId,
      body.participantId,
      feedback,
    );
    return { ok: true };
  }

  /** Mark the discussion finished (called when the timer runs out). */
  @Post("sessions/:id/complete")
  @UseGuards(ParticipantGuard)
  async complete(@Param("id") id: string): Promise<{ ok: true }> {
    // The service returns its internal Session for its own idempotency tests;
    // never serialize participant tokens or survey answers back to a browser.
    await this.sessions.completeSession(id);
    return { ok: true };
  }

  /** Mark one participant complete after their exit survey is safely stored. */
  @Post("sessions/:sessionId/participants/:participantId/complete")
  @UseGuards(ParticipantGuard)
  completeParticipant(
    @Param("sessionId") sessionId: string,
    @Param("participantId") participantId: string,
  ) {
    return this.sessions.completeParticipant(sessionId, participantId);
  }

  /** Chat Service hands back the collected discussion at session end. */
  @Post("sessions/:id/finalize")
  @UseGuards(InternalGuard)
  finalize(
    @Param("id") id: string,
    @Body() body: FinalizeSessionRequest,
  ): Promise<Session> {
    return this.sessions.finalizeSession(id, body);
  }

  /** Chat Service incrementally persists live state without completing it. */
  @Put("sessions/:id/checkpoint")
  @UseGuards(InternalGuard)
  checkpoint(
    @Param("id") id: string,
    @Body() body: CheckpointSessionRequest,
  ): Promise<{ ok: true }> {
    return this.sessions.checkpointSession(id, body).then(() => ({ ok: true }));
  }

  /** Re-invite a restarted bot and return all recoverable running sessions. */
  @Post("sessions/recover")
  @UseGuards(InternalGuard)
  recover(@Body() body: RecoverSessionsRequest) {
    return this.sessions.recoverRunningSessions(
      body.botUserId,
      body.comparisonBotUserIds ?? [],
    );
  }

  /** Admin: list editable study conditions. */
  @Get("conditions")
  @UseGuards(AdminGuard)
  conditions() {
    return this.store.listConditions();
  }

  /** Admin: per-condition progress in the CURRENT round (done vs. goal). */
  @Get("conditions/progress")
  @UseGuards(AdminGuard)
  async progress(): Promise<ConditionProgress[]> {
    const [conditions, round] = await Promise.all([
      this.store.listConditions(),
      this.store.currentRound(),
    ]);
    return Promise.all(
      conditions.map(async (condition) => ({
        condition,
        completed: await this.store.completedCount(condition.id, round.id),
        goal: condition.goal,
      })),
    );
  }

  /** Admin: update a condition in the current store. */
  @Put("conditions/:id")
  @UseGuards(AdminGuard)
  upsertCondition(
    @Param("id") id: string,
    @Body() body: UpsertConditionRequest,
  ) {
    validateCondition(body?.condition);
    return this.store.upsertCondition({ ...body.condition, id });
  }

  /** Study-wide settings; the participant app reads the compensation link. */
  @Get("settings")
  @UseGuards(AdminGuard)
  settings(): Promise<StudySettings> {
    return this.store.getStudySettings();
  }

  /** Admin: update study-wide settings (e.g. the compensation link). */
  @Put("settings")
  @UseGuards(AdminGuard)
  updateSettings(
    @Body() body: UpdateStudySettingsRequest,
  ): Promise<StudySettings> {
    const settings = body?.settings ?? {};
    const allowedKeys = new Set<keyof StudySettings>([
      "compensationUrl",
      "noConsentUrl",
      "ineligibleUrl",
      "withdrawalUrl",
      "unmatchedUrl",
      "technicalFailureUrl",
    ]);
    for (const key of Object.keys(settings)) {
      if (!allowedKeys.has(key as keyof StudySettings)) {
        throw new BadRequestException(`Unknown study setting: ${key}`);
      }
    }
    return this.store.updateStudySettings(
      Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [
          key,
          validateCompensationUrl(value ?? "", key),
        ]),
      ),
    );
  }

  @Get("admin/prolific/outcomes")
  @UseGuards(AdminGuard)
  async participationOutcomes() {
    return { outcomes: await this.store.listParticipationOutcomes() };
  }

  @Post("admin/prolific/outcomes/:id/actions/:action")
  @UseGuards(AdminGuard)
  processParticipationOutcome(
    @Param("id") id: string,
    @Param("action") action: string,
  ) {
    switch (action) {
      case "request-return":
        return this.prolificActions.requestReturnById(id);
      case "prepare-bonus":
        return this.prolificActions.prepareBonusById(id);
      case "pay-bonus":
        return this.prolificActions.payBonusById(id);
      case "resolve-manually":
        return this.prolificActions.resolveManuallyById(id);
      default:
        throw new BadRequestException("Unknown Prolific action");
    }
  }

  /** Admin/debug: newest interventions across all sessions. */
  @Get("interventions")
  @UseGuards(AdminGuard)
  interventions() {
    return this.sessions.listInterventions();
  }

  /** JSON export for currently persisted research sessions. */
  @Get("export/sessions")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="detailed_data.json"')
  exportSessions(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.sessions.exportBundle(researchFilter(conditionIds, roundIds));
  }

  /** CSV summary export for currently persisted research sessions. */
  @Get("export/sessions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="overview.csv"')
  exportSessionsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.sessions.exportCsv(researchFilter(conditionIds, roundIds));
  }

  /** Chat logs export (one row per message). */
  @Get("export/messages")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="messages.json"')
  exportMessages(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.sessions.exportMessages(researchFilter(conditionIds, roundIds));
  }

  @Get("export/messages.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="messages.csv"')
  exportMessagesCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.sessions.exportMessagesCsv(researchFilter(conditionIds, roundIds));
  }

  /** Bot nudge events export (one row per intervention). */
  @Get("export/interventions")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="interventions.json"')
  exportInterventions(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.sessions.exportInterventions(researchFilter(conditionIds, roundIds));
  }

  @Get("export/interventions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="interventions.csv"')
  exportInterventionsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.sessions.exportInterventionsCsv(researchFilter(conditionIds, roundIds));
  }

  /** Survey responses export (one row per participant and kind). */
  @Get("export/surveys")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="surveys.json"')
  exportSurveys(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.sessions.exportSurveys(researchFilter(conditionIds, roundIds));
  }

  @Get("export/surveys.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="surveys.csv"')
  exportSurveysCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.sessions.exportSurveysCsv(researchFilter(conditionIds, roundIds));
  }

  /** Prolific arrivals, including people who left before claiming a seat. */
  @Get("export/prolific-arrivals")
  @UseGuards(AdminGuard)
  exportProlificArrivals() {
    return this.store.listProlificArrivals();
  }

  @Get("export/prolific-outcomes")
  @UseGuards(AdminGuard)
  async exportProlificOutcomes() {
    return { outcomes: await this.store.listParticipationOutcomes() };
  }

  /** Behavioral events and per-participant aggregate contribution measures. */
  @Get("export/contributions")
  @UseGuards(AdminGuard)
  @Header("Content-Disposition", 'attachment; filename="contributions.json"')
  exportContributions(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ) {
    return this.sessions.exportContributions(researchFilter(conditionIds, roundIds));
  }

  @Get("export/contributions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="contributions.csv"')
  exportContributionsCsv(
    @Query("conditionIds") conditionIds?: string,
    @Query("roundIds") roundIds?: string,
  ): Promise<string> {
    return this.sessions.exportContributionsCsv(researchFilter(conditionIds, roundIds));
  }
}

function researchFilter(conditionIds?: string, roundIds?: string) {
  return {
    conditionIds: parseConditionIds(conditionIds),
    roundIds: parseRoundIds(roundIds),
  };
}
