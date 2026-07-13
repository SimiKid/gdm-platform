import {
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
import type {
  ConditionProgress,
  CheckpointSessionRequest,
  FinalizeSessionRequest,
  RecoverSessionsRequest,
  OpenSessionRequest,
  OpenSessionResponse,
  PublicSession,
  Session,
  SessionSummary,
  StudySettings,
  SubmitSurveyRequest,
  UpdateStudySettingsRequest,
  UpsertConditionRequest,
} from "@gdm/shared";
import { SessionsService } from "./sessions.service";
import { StoreService } from "../store/store.service";
import { AdminGuard } from "../auth/admin.guard";
import { InternalGuard } from "../auth/internal.guard";

@Controller()
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly store: StoreService,
  ) {}

  @Post("sessions")
  openSession(@Body() body: OpenSessionRequest): Promise<OpenSessionResponse> {
    return this.sessions.openSession(body);
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
  async submitSurvey(@Body() body: SubmitSurveyRequest): Promise<{ ok: true }> {
    await this.sessions.submitSurvey(body);
    return { ok: true };
  }

  /** Mark the discussion finished (called when the timer runs out). */
  @Post("sessions/:id/complete")
  complete(@Param("id") id: string): Promise<Session> {
    return this.sessions.completeSession(id);
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
  ): Promise<Session> {
    return this.sessions.checkpointSession(id, body);
  }

  /** Re-invite a restarted bot and return all recoverable running sessions. */
  @Post("sessions/recover")
  @UseGuards(InternalGuard)
  recover(@Body() body: RecoverSessionsRequest) {
    return this.sessions.recoverRunningSessions(body.botUserId);
  }

  /** Admin: list editable study conditions. */
  @Get("conditions")
  @UseGuards(AdminGuard)
  conditions() {
    return this.store.listConditions();
  }

  /** Admin: per-condition progress (how many done vs. goal). */
  @Get("conditions/progress")
  @UseGuards(AdminGuard)
  async progress(): Promise<ConditionProgress[]> {
    const conditions = await this.store.listConditions();
    return Promise.all(
      conditions.map(async (condition) => ({
        condition,
        completed: await this.store.completedCount(condition.id),
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
    return this.store.upsertCondition({ ...body.condition, id });
  }

  /** Study-wide settings; the participant app reads the compensation link. */
  @Get("settings")
  settings(): Promise<StudySettings> {
    return this.store.getStudySettings();
  }

  /** Admin: update study-wide settings (e.g. the compensation link). */
  @Put("settings")
  @UseGuards(AdminGuard)
  updateSettings(
    @Body() body: UpdateStudySettingsRequest,
  ): Promise<StudySettings> {
    return this.store.updateStudySettings(body.settings ?? {});
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
  exportSessions(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportBundle(parseConditionIds(conditionIds));
  }

  /** CSV summary export for currently persisted research sessions. */
  @Get("export/sessions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportSessionsCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportCsv(parseConditionIds(conditionIds));
  }

  /** Chat logs export (one row per message). */
  @Get("export/messages")
  @UseGuards(AdminGuard)
  exportMessages(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportMessages(parseConditionIds(conditionIds));
  }

  @Get("export/messages.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportMessagesCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportMessagesCsv(parseConditionIds(conditionIds));
  }

  /** Bot nudge events export (one row per intervention). */
  @Get("export/interventions")
  @UseGuards(AdminGuard)
  exportInterventions(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportInterventions(parseConditionIds(conditionIds));
  }

  @Get("export/interventions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportInterventionsCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.sessions.exportInterventionsCsv(parseConditionIds(conditionIds));
  }

  /** Survey responses export (one row per participant and kind). */
  @Get("export/surveys")
  @UseGuards(AdminGuard)
  exportSurveys(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportSurveys(parseConditionIds(conditionIds));
  }

  @Get("export/surveys.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportSurveysCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportSurveysCsv(parseConditionIds(conditionIds));
  }

  /** Behavioral events and per-participant aggregate contribution measures. */
  @Get("export/contributions")
  @UseGuards(AdminGuard)
  exportContributions(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportContributions(parseConditionIds(conditionIds));
  }

  @Get("export/contributions.csv")
  @UseGuards(AdminGuard)
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportContributionsCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.sessions.exportContributionsCsv(parseConditionIds(conditionIds));
  }
}

function parseConditionIds(conditionIds?: string): string[] {
  return conditionIds
    ? conditionIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];
}
