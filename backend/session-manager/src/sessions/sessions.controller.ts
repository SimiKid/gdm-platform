import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import type {
  ConditionProgress,
  FinalizeSessionRequest,
  OpenSessionRequest,
  OpenSessionResponse,
  Session,
  SessionSummary,
  StudySettings,
  SubmitSurveyRequest,
  UpdateStudySettingsRequest,
  UpsertConditionRequest,
} from "@gdm/shared";
import { SessionsService } from "./sessions.service";
import { StoreService } from "../store/store.service";

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

  /** Admin/debug: list all sessions. */
  @Get("sessions")
  listSessions(): Promise<SessionSummary[]> {
    return this.sessions.listSessions();
  }

  /** Waiting Room polls this for the live count and the roomId once ready. */
  @Get("sessions/:id")
  getSession(@Param("id") id: string): Promise<Session> {
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
  finalize(
    @Param("id") id: string,
    @Body() body: FinalizeSessionRequest,
  ): Promise<Session> {
    return this.sessions.finalizeSession(
      id,
      body.messages,
      body.rankingHistory,
      body.interventions ?? [],
    );
  }

  /** Admin: list editable study conditions. */
  @Get("conditions")
  conditions() {
    return this.store.listConditions();
  }

  /** Admin: per-condition progress (how many done vs. goal). */
  @Get("conditions/progress")
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
  updateSettings(
    @Body() body: UpdateStudySettingsRequest,
  ): Promise<StudySettings> {
    return this.store.updateStudySettings(body.settings ?? {});
  }

  /** Admin/debug: newest interventions across all sessions. */
  @Get("interventions")
  interventions() {
    return this.sessions.listInterventions();
  }

  /** JSON export for currently persisted research sessions. */
  @Get("export/sessions")
  exportSessions(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportBundle(parseConditionIds(conditionIds));
  }

  /** CSV summary export for currently persisted research sessions. */
  @Get("export/sessions.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportSessionsCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportCsv(parseConditionIds(conditionIds));
  }

  /** Chat logs export (one row per message). */
  @Get("export/messages")
  exportMessages(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportMessages(parseConditionIds(conditionIds));
  }

  @Get("export/messages.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportMessagesCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportMessagesCsv(parseConditionIds(conditionIds));
  }

  /** Bot nudge events export (one row per intervention). */
  @Get("export/interventions")
  exportInterventions(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportInterventions(parseConditionIds(conditionIds));
  }

  @Get("export/interventions.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportInterventionsCsv(
    @Query("conditionIds") conditionIds?: string,
  ): Promise<string> {
    return this.sessions.exportInterventionsCsv(parseConditionIds(conditionIds));
  }

  /** Survey responses export (one row per participant and kind). */
  @Get("export/surveys")
  exportSurveys(@Query("conditionIds") conditionIds?: string) {
    return this.sessions.exportSurveys(parseConditionIds(conditionIds));
  }

  @Get("export/surveys.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  exportSurveysCsv(@Query("conditionIds") conditionIds?: string): Promise<string> {
    return this.sessions.exportSurveysCsv(parseConditionIds(conditionIds));
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
