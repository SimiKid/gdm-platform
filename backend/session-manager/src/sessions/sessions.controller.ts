import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import type {
  ConditionProgress,
  OpenSessionRequest,
  OpenSessionResponse,
  Session,
  SubmitSurveyRequest,
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

  /** Waiting Room polls this for the live count and the roomId once ready. */
  @Get("sessions/:id")
  getSession(@Param("id") id: string): Session {
    return this.sessions.getSession(id);
  }

  @Post("surveys")
  submitSurvey(@Body() body: SubmitSurveyRequest): { ok: true } {
    this.sessions.submitSurvey(body);
    return { ok: true };
  }

  /** Admin: per-condition progress (how many done vs. goal). */
  @Get("conditions/progress")
  progress(): ConditionProgress[] {
    return this.store.listConditions().map((condition) => ({
      condition,
      completed: this.store.completedCount(condition.id),
      goal: condition.goal,
    }));
  }
}
