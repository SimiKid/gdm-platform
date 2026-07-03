import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EXPEDITION_MARS, EXPEDITION_MARS_BRIEFING } from "@gdm/shared";
import type { Condition, Session } from "@gdm/shared";
import type { MatrixCreds } from "../matrix/matrix.service";

/**
 * In-memory store behind a narrow surface, so it can be swapped for a real
 * TypeORM/Prisma repository against the research Postgres later with no
 * changes to SessionsService. Data resets on restart — dev only.
 */

const BRIEFING = EXPEDITION_MARS_BRIEFING;
const RANKING_TASK = EXPEDITION_MARS;

@Injectable()
export class StoreService {
  private readonly conditions: Condition[] = [];
  private readonly sessions = new Map<string, Session>();
  /** participantId -> Matrix creds (kept out of the Session DTO). */
  readonly creds = new Map<string, MatrixCreds>();

  constructor() {
    this.seed();
  }

  private seed(): void {
    for (const n of [1, 2, 3]) {
      this.conditions.push({
        id: `cond-${n}`,
        name: `Condition ${n}`,
        active: true,
        goal: 5,
        durationMinutes: 10,
        groupSize: 3,
        config: {},
      });
    }
  }

  listConditions(): Condition[] {
    return this.conditions;
  }

  /** Sessions counting against a condition's goal (everything but aborted). */
  claimedCount(conditionId: string): number {
    return this.allSessions().filter(
      (s) => s.condition.id === conditionId && s.status !== "aborted",
    ).length;
  }

  completedCount(conditionId: string): number {
    return this.allSessions().filter(
      (s) => s.condition.id === conditionId && s.status === "completed",
    ).length;
  }

  allSessions(): Session[] {
    return [...this.sessions.values()];
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  saveSession(session: Session): void {
    this.sessions.set(session.id, session);
  }

  /** The oldest still-forming session with a free seat, if any. */
  findForming(): Session | undefined {
    return this.allSessions()
      .filter(
        (s) =>
          s.status === "waiting" &&
          s.participants.length < s.condition.groupSize,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  createForming(condition: Condition): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      status: "waiting",
      condition,
      bot: { llmEnabled: false, condition },
      participants: [],
      chat: { messages: [] },
      briefing: BRIEFING,
      rankingTask: RANKING_TASK,
      ranking: {
        taskId: RANKING_TASK.id,
        order: RANKING_TASK.items.map((i) => i.id),
        updatedAt: now,
        updatedBy: "system",
      },
      polls: [],
      durationMinutes: condition.durationMinutes,
      createdAt: now,
    };
    this.saveSession(session);
    return session;
  }
}
