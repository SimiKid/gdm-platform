import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  Briefing,
  Condition,
  RankingTask,
  Session,
} from "@gdm/shared";
import type { MatrixCreds } from "../matrix/matrix.service";

/**
 * In-memory store behind a narrow surface, so it can be swapped for a real
 * TypeORM/Prisma repository against the research Postgres later with no
 * changes to SessionsService. Data resets on restart — dev only.
 */

const BRIEFING: Briefing = {
  title: "Expedition Mars",
  html:
    "<p>Your crew has crash-landed 200 km from the rendezvous point on Mars. " +
    "Much of the equipment was damaged. As a group, rank the surviving items " +
    "by how critical they are for reaching the rendezvous point. Discuss in " +
    "the chat and agree on a shared ranking.</p>",
};

const RANKING_TASK: RankingTask = {
  id: "expedition-mars",
  title: "Rank the surviving equipment (most to least critical)",
  items: [
    { id: "oxygen", label: "Oxygen tanks" },
    { id: "water", label: "Water (20 litres)" },
    { id: "map", label: "Star map of Mars' constellations" },
    { id: "radio", label: "Solar-powered FM radio" },
    { id: "firstaid", label: "First-aid kit" },
    { id: "food", label: "Case of dehydrated food" },
    { id: "heater", label: "Portable heating unit" },
    { id: "rope", label: "50 m of nylon rope" },
    { id: "flares", label: "Signal flares" },
    { id: "compass", label: "Magnetic compass" },
  ],
};

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
