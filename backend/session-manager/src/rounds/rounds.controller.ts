import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import type {
  RoundsResponse,
  StartRoundRequest,
  StartRoundResponse,
  StudyRound,
  UpdateRoundRequest,
} from "@gdm/shared";
import { AdminGuard } from "../auth/admin.guard";
import { SessionsService } from "../sessions/sessions.service";
import { StoreService } from "../store/store.service";

/**
 * Study rounds: the researcher runs the study in numbered waves, possibly
 * with different Session & Bot Parameters per round. Sessions are stamped
 * with the round open at their creation; recruiting progress and goals
 * count per round.
 */
@Controller()
export class RoundsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly store: StoreService,
  ) {}

  @Get("rounds")
  @UseGuards(AdminGuard)
  async list(): Promise<RoundsResponse> {
    const [current, rounds] = await Promise.all([
      this.store.currentRound(),
      this.store.listRounds(),
    ]);
    return { currentRound: current.id, rounds };
  }

  /** Close the current round, abort waiting lobbies, open round N+1. */
  @Post("rounds")
  @UseGuards(AdminGuard)
  start(@Body() body: StartRoundRequest): Promise<StartRoundResponse> {
    return this.sessions.startRound(body?.label);
  }

  /** Rename a round (the free-text label; numbers are fixed). */
  @Put("rounds/:number")
  @UseGuards(AdminGuard)
  async rename(
    @Param("number") number: string,
    @Body() body: UpdateRoundRequest,
  ): Promise<StudyRound> {
    const id = Number(number);
    const updated = Number.isInteger(id)
      ? await this.store.updateRoundLabel(id, body?.label ?? "")
      : undefined;
    if (!updated) throw new NotFoundException(`Unknown round ${number}`);
    const rounds = await this.store.listRounds();
    return (
      rounds.find((round) => round.number === updated.id) ?? {
        number: updated.id,
        label: updated.label,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt,
        sessionCount: 0,
        completedCount: 0,
      }
    );
  }
}
