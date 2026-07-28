import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomInt, randomUUID } from "node:crypto";
import {
  DEFAULT_INTERVENTION_CONFIG,
  MOON_SURVIVAL,
  MOON_SURVIVAL_BRIEFING,
  normalizeInterventionMode,
} from "@gdm/shared";
import type {
  Briefing,
  BehavioralEvent,
  BotConfig,
  Condition,
  ContributionClassification,
  InterventionLog,
  InterventionMode,
  Message,
  Participant,
  Poll,
  Ranking,
  RankingTask,
  Session,
  StudySettings,
  Survey,
} from "@gdm/shared";
import type { MatrixCreds } from "../matrix/matrix.service";
import { PrismaService } from "../prisma/prisma.service";

const BRIEFING = MOON_SURVIVAL_BRIEFING;
const RANKING_TASK = MOON_SURVIVAL;

const SESSION_INCLUDE = {
  participants: {
    include: { surveys: true },
    orderBy: { createdAt: "asc" },
  },
  messages: {
    include: { reactions: true },
    orderBy: { timestamp: "asc" },
  },
  rankingHistory: {
    orderBy: { position: "asc" },
  },
  interventions: {
    orderBy: { timestamp: "asc" },
  },
} satisfies Prisma.SessionRecordInclude;

type SessionRow = Prisma.SessionRecordGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/**
 * Persistence boundary for study state.
 *
 * Docker/local stack uses Postgres through Prisma when DATABASE_URL is set.
 * Unit tests and ad-hoc non-DB runs fall back to the same in-memory behavior
 * the app previously used, keeping test setup light while making Docker data
 * durable across backend restarts.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly conditions: Condition[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly memoryCreds = new Map<string, MatrixCreds>();
  private readonly memorySettings: StudySettings = { compensationUrl: "" };
  private seedPromise?: Promise<void>;

  constructor(@Optional() private readonly prisma?: PrismaService) {
    if (!this.dbEnabled) this.seedMemory();
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSeeded();
  }

  async listConditions(): Promise<Condition[]> {
    if (!this.dbEnabled) return this.conditions;
    await this.ensureSeeded();
    const rows = await this.db.conditionRecord.findMany();
    return rows.map(conditionFromRow).sort(sortConditions);
  }

  async upsertCondition(condition: Condition): Promise<Condition> {
    const next = normalizeCondition(condition);
    if (!this.dbEnabled) {
      const idx = this.conditions.findIndex((c) => c.id === next.id);
      if (idx >= 0) this.conditions[idx] = next;
      else this.conditions.push(next);
      return next;
    }

    await this.ensureSeeded();
    await this.db.conditionRecord.upsert({
      where: { id: next.id },
      create: conditionData(next),
      update: conditionData(next),
    });
    return next;
  }

  /** Study-wide settings (e.g. the compensation link on the debriefing page). */
  async getStudySettings(): Promise<StudySettings> {
    if (!this.dbEnabled) return { ...this.memorySettings };
    await this.ensureSeeded();
    const rows = await this.db.studySettingRecord.findMany();
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    return { compensationUrl: byKey.get("compensationUrl") ?? "" };
  }

  async updateStudySettings(
    patch: Partial<StudySettings>,
  ): Promise<StudySettings> {
    const entries = Object.entries(patch).filter(
      ([, value]) => typeof value === "string",
    ) as [string, string][];

    if (!this.dbEnabled) {
      for (const [key, value] of entries) {
        this.memorySettings[key as keyof StudySettings] = value.trim();
      }
      return { ...this.memorySettings };
    }

    await this.ensureSeeded();
    for (const [key, value] of entries) {
      await this.db.studySettingRecord.upsert({
        where: { key },
        create: { key, value: value.trim() },
        update: { value: value.trim() },
      });
    }
    return this.getStudySettings();
  }

  /** Sessions counting against a condition's goal (everything but aborted). */
  async claimedCount(conditionId: string): Promise<number> {
    if (!this.dbEnabled) {
      return this.allMemorySessions().filter(
        (s) => s.condition.id === conditionId && s.status !== "aborted",
      ).length;
    }
    await this.ensureSeeded();
    return this.db.sessionRecord.count({
      where: {
        conditionId,
        status: { not: "aborted" },
      },
    });
  }

  async completedCount(conditionId: string): Promise<number> {
    if (!this.dbEnabled) {
      return this.allMemorySessions().filter(
        (s) => s.condition.id === conditionId && s.status === "completed",
      ).length;
    }
    await this.ensureSeeded();
    return this.db.sessionRecord.count({
      where: { conditionId, status: "completed" },
    });
  }

  async allSessions(): Promise<Session[]> {
    if (!this.dbEnabled) return this.allMemorySessions();
    await this.ensureSeeded();
    const rows = await this.db.sessionRecord.findMany({
      include: SESSION_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(sessionFromRow);
  }

  async getSession(id: string): Promise<Session | undefined> {
    if (!this.dbEnabled) return this.sessions.get(id);
    await this.ensureSeeded();
    const row = await this.db.sessionRecord.findUnique({
      where: { id },
      include: SESSION_INCLUDE,
    });
    return row ? sessionFromRow(row) : undefined;
  }

  async getCondition(id: string): Promise<Condition | undefined> {
    if (!this.dbEnabled) return this.conditions.find((condition) => condition.id === id);
    await this.ensureSeeded();
    const row = await this.db.conditionRecord.findUnique({ where: { id } });
    return row ? conditionFromRow(row) : undefined;
  }

  async saveSession(session: Session): Promise<void> {
    if (!this.dbEnabled) {
      this.sessions.set(session.id, session);
      return;
    }

    await this.ensureConditionExists(session.condition);
    await this.db.$transaction(async (tx) => {
      await tx.sessionRecord.upsert({
        where: { id: session.id },
        create: {
          id: session.id,
          status: session.status,
          conditionId: session.condition.id,
          conditionSnapshot: json(session.condition),
          bot: json(session.bot),
          briefing: json(session.briefing),
          rankingTask: json(session.rankingTask),
          ranking: json(session.ranking),
          polls: json(session.polls),
          behavioralEvents: json(session.behavioralEvents),
          classifications: json(session.contributionClassifications),
          processedEventIds: json(session.processedEventIds ?? []),
          runtimeState: json(session.runtimeState ?? {}),
          durationMinutes: session.durationMinutes,
          roomId: session.roomId,
          createdAt: toDate(session.createdAt),
          startedAt: toOptionalDate(session.startedAt),
          completedAt: toOptionalDate(session.completedAt),
        },
        update: {
          status: session.status,
          conditionId: session.condition.id,
          conditionSnapshot: json(session.condition),
          bot: json(session.bot),
          briefing: json(session.briefing),
          rankingTask: json(session.rankingTask),
          ranking: json(session.ranking),
          polls: json(session.polls),
          behavioralEvents: json(session.behavioralEvents),
          classifications: json(session.contributionClassifications),
          processedEventIds: json(session.processedEventIds ?? []),
          runtimeState: json(session.runtimeState ?? {}),
          durationMinutes: session.durationMinutes,
          roomId: session.roomId,
          startedAt: toOptionalDate(session.startedAt),
          completedAt: toOptionalDate(session.completedAt),
        },
      });

      await this.saveParticipants(tx, session);
      await this.replaceMessages(tx, session);
      await this.replaceRankingHistory(tx, session);
      await this.replaceInterventions(tx, session);
    });
  }

  /** Persist only live chat-owned fields; never overwrite lifecycle/surveys. */
  async saveRuntimeCheckpoint(session: Session): Promise<void> {
    if (!this.dbEnabled) {
      const stored = this.sessions.get(session.id);
      if (!stored) return;
      stored.chat = session.chat;
      stored.ranking = session.ranking;
      stored.rankingHistory = session.rankingHistory;
      stored.interventions = session.interventions;
      stored.behavioralEvents = session.behavioralEvents;
      stored.contributionClassifications = session.contributionClassifications;
      stored.processedEventIds = session.processedEventIds;
      stored.runtimeState = session.runtimeState;
      return;
    }

    await this.db.$transaction(async (tx) => {
      await tx.sessionRecord.update({
        where: { id: session.id },
        data: {
          ranking: json(session.ranking),
          behavioralEvents: json(session.behavioralEvents),
          classifications: json(session.contributionClassifications),
          processedEventIds: json(session.processedEventIds ?? []),
          runtimeState: json(session.runtimeState ?? {}),
        },
      });
      await this.replaceMessages(tx, session);
      await this.replaceRankingHistory(tx, session);
      await this.replaceInterventions(tx, session);
    });
  }

  /** The oldest still-forming session with a free seat, if any. */
  async findForming(): Promise<Session | undefined> {
    const sessions = this.dbEnabled
      ? await this.waitingSessionsFromDb()
      : this.allMemorySessions().filter((s) => s.status === "waiting");
    return sessions
      .filter((s) => s.participants.length < s.condition.groupSize)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  async createForming(condition: Condition): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      status: "waiting",
      condition,
      bot: { llmEnabled: condition.config.llmMode === "active", condition },
      participants: [],
      chat: { messages: [] },
      briefing: BRIEFING,
      rankingTask: RANKING_TASK,
      ranking: {
        taskId: RANKING_TASK.id,
        // Shuffle once when the group session is created. The persisted order
        // is then shared with every participant in that session.
        order: shuffleRankingOrder(RANKING_TASK.items.map((i) => i.id)),
        updatedAt: now,
        updatedBy: "system",
      },
      interventions: [],
      behavioralEvents: [],
      contributionClassifications: [],
      processedEventIds: [],
      runtimeState: {},
      polls: [],
      durationMinutes: condition.durationMinutes,
      createdAt: now,
    };
    await this.saveSession(session);
    return session;
  }

  async setParticipantCreds(
    participantId: string,
    creds: MatrixCreds,
  ): Promise<void> {
    if (!this.dbEnabled) {
      this.memoryCreds.set(participantId, creds);
      return;
    }
    await this.db.participantRecord.update({
      where: { id: participantId },
      data: {
        matrixUserId: creds.userId,
        matrixAccessToken: creds.accessToken,
      },
    });
  }

  async getParticipantCreds(
    participantId: string,
  ): Promise<MatrixCreds | undefined> {
    if (!this.dbEnabled) return this.memoryCreds.get(participantId);
    const participant = await this.db.participantRecord.findUnique({
      where: { id: participantId },
      select: { matrixUserId: true, matrixAccessToken: true },
    });
    if (!participant?.matrixUserId || !participant.matrixAccessToken) return undefined;
    return {
      userId: participant.matrixUserId,
      accessToken: participant.matrixAccessToken,
    };
  }

  private get dbEnabled(): boolean {
    return Boolean(process.env.DATABASE_URL && this.prisma);
  }

  private get db(): PrismaService {
    if (!this.prisma) {
      throw new Error("DATABASE_URL is set but PrismaService is unavailable");
    }
    return this.prisma;
  }

  private async ensureSeeded(): Promise<void> {
    if (!this.dbEnabled) {
      this.seedMemory();
      return;
    }
    this.seedPromise ??= this.seedDb();
    await this.seedPromise;
  }

  private seedMemory(): void {
    if (this.conditions.length > 0) return;
    this.conditions.push(...seedConditions());
  }

  private async seedDb(): Promise<void> {
    for (const condition of seedConditions()) {
      await this.db.conditionRecord.upsert({
        where: { id: condition.id },
        create: conditionData(condition),
        update: {},
      });
    }
  }

  private async ensureConditionExists(condition: Condition): Promise<void> {
    await this.ensureSeeded();
    const exists = await this.db.conditionRecord.findUnique({
      where: { id: condition.id },
      select: { id: true },
    });
    if (!exists) {
      await this.db.conditionRecord.create({
        data: conditionData(normalizeCondition(condition)),
      });
    }
  }

  private allMemorySessions(): Session[] {
    return [...this.sessions.values()];
  }

  private async waitingSessionsFromDb(): Promise<Session[]> {
    await this.ensureSeeded();
    const rows = await this.db.sessionRecord.findMany({
      where: { status: "waiting" },
      include: SESSION_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(sessionFromRow);
  }

  private async saveParticipants(
    tx: Prisma.TransactionClient,
    session: Session,
  ): Promise<void> {
    for (const participant of session.participants) {
      await tx.participantRecord.upsert({
        where: { id: participant.id },
        create: {
          id: participant.id,
          sessionId: session.id,
          name: participant.name,
          trackingToken: participant.trackingToken,
        },
        update: {
          sessionId: session.id,
          name: participant.name,
          trackingToken: participant.trackingToken,
        },
      });
      await this.saveSurvey(tx, participant, "entry", participant.entrySurvey);
      await this.saveSurvey(tx, participant, "exit", participant.exitSurvey);
    }
  }

  private async saveSurvey(
    tx: Prisma.TransactionClient,
    participant: Participant,
    kind: "entry" | "exit",
    survey: Survey | undefined,
  ): Promise<void> {
    if (!survey) return;
    await tx.surveyRecord.upsert({
      where: {
        participantId_kind: {
          participantId: participant.id,
          kind,
        },
      },
      create: {
        participantId: participant.id,
        kind,
        answers: json(survey.answers),
        submittedAt: toDate(survey.submittedAt),
      },
      update: {
        answers: json(survey.answers),
        submittedAt: toDate(survey.submittedAt),
      },
    });
  }

  private async replaceMessages(
    tx: Prisma.TransactionClient,
    session: Session,
  ): Promise<void> {
    await tx.messageRecord.deleteMany({ where: { sessionId: session.id } });
    for (const message of session.chat.messages) {
      await tx.messageRecord.create({
        data: {
          id: message.id,
          sessionId: session.id,
          timestamp: toDate(message.timestamp),
          senderId: message.senderId,
          recipientId: message.recipientId,
          text: message.text,
          reactions: {
            create: message.reactions.map((reaction) => ({
              key: reaction.key,
              senderId: reaction.senderId,
              timestamp: toDate(reaction.timestamp),
            })),
          },
        },
      });
    }
  }

  private async replaceRankingHistory(
    tx: Prisma.TransactionClient,
    session: Session,
  ): Promise<void> {
    await tx.rankingHistoryRecord.deleteMany({ where: { sessionId: session.id } });
    for (const [position, ranking] of (session.rankingHistory ?? []).entries()) {
      await tx.rankingHistoryRecord.create({
        data: {
          sessionId: session.id,
          position,
          ranking: json(ranking),
          updatedAt: toDate(ranking.updatedAt),
        },
      });
    }
  }

  private async replaceInterventions(
    tx: Prisma.TransactionClient,
    session: Session,
  ): Promise<void> {
    await tx.interventionRecord.deleteMany({ where: { sessionId: session.id } });
    for (const intervention of session.interventions) {
      await tx.interventionRecord.create({
        data: {
          id: intervention.id,
          sessionId: session.id,
          roomId: intervention.roomId,
          conditionId: intervention.conditionId,
          mode: intervention.mode,
          audience: intervention.audience,
          timestamp: toDate(intervention.timestamp),
          trigger: intervention.trigger,
          threshold: intervention.threshold,
          contributionWindowMinutes: intervention.contributionWindowMinutes,
          message: intervention.message,
          payload: json(intervention),
        },
      });
    }
  }
}

/** Unbiased Fisher-Yates shuffle for a new shared-ranking starting order. */
export function shuffleRankingOrder(
  itemIds: string[],
  pickIndex: (maxExclusive: number) => number = randomInt,
): string[] {
  const shuffled = itemIds.slice();
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapWith = pickIndex(index + 1);
    [shuffled[index], shuffled[swapWith]] = [
      shuffled[swapWith],
      shuffled[index],
    ];
  }
  return shuffled;
}

/**
 * The study's 2×2 + baseline design: delivery (public/private) × detection
 * (rule-based / rule-based + LLM meaningfulness). Detection is carried by
 * `llmMode` ("off" = rule-based, "active" = rule + LLM).
 */
function seedConditions(): Condition[] {
  const arms: {
    id: string;
    name: string;
    mode: InterventionMode;
    llmMode: "off" | "active";
  }[] = [
    { id: "baseline", name: "Baseline", mode: "baseline", llmMode: "off" },
    { id: "public-rule", name: "Public × Rule-based", mode: "public", llmMode: "off" },
    { id: "public-llm", name: "Public × Rule+LLM", mode: "public", llmMode: "active" },
    { id: "private-rule", name: "Private × Rule-based", mode: "private", llmMode: "off" },
    { id: "private-llm", name: "Private × Rule+LLM", mode: "private", llmMode: "active" },
  ];

  return arms.map((arm) =>
    normalizeCondition({
      id: arm.id,
      name: arm.name,
      active: true,
      goal: 5,
      durationMinutes: 10,
      groupSize: 3,
      config: {
        ...DEFAULT_INTERVENTION_CONFIG,
        interventionMode: arm.mode,
        llmMode: arm.llmMode,
        scoreWeights: { ...DEFAULT_INTERVENTION_CONFIG.scoreWeights },
      },
    }),
  );
}

function normalizeCondition(condition: Condition): Condition {
  return {
    ...condition,
    // Admin input can arrive empty/NaN — clamp to values a session can run
    // with (duration 0 would mean a countdown that never starts).
    goal: clampInt(condition.goal, 0),
    durationMinutes: clampInt(condition.durationMinutes, 1),
    groupSize: clampInt(condition.groupSize, 2),
    config: {
      ...DEFAULT_INTERVENTION_CONFIG,
      ...condition.config,
      // Conditions stored before the tone axis was retired carry old mode
      // strings like "public-engaging" — fold them onto the delivery axis.
      interventionMode: normalizeInterventionMode(
        condition.config.interventionMode ??
          DEFAULT_INTERVENTION_CONFIG.interventionMode,
      ),
      scoreWeights: {
        ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
        ...condition.config.scoreWeights,
      },
      dominanceWeights: {
        ...DEFAULT_INTERVENTION_CONFIG.dominanceWeights,
        ...condition.config.dominanceWeights,
      },
      // Warm-up can be 0 (none); fractions allowed like the window.
      protectedStartMinutes: clampNonNegative(
        condition.config.protectedStartMinutes ??
          DEFAULT_INTERVENTION_CONFIG.protectedStartMinutes,
        DEFAULT_INTERVENTION_CONFIG.protectedStartMinutes,
      ),
      // Fractional minutes allowed (pilots/tests use sub-minute windows).
      contributionWindowMinutes: clampMinutes(
        condition.config.contributionWindowMinutes ??
          DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
        DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
      ),
      contributionThreshold: clampFraction(
        condition.config.contributionThreshold ??
          DEFAULT_INTERVENTION_CONFIG.contributionThreshold,
        DEFAULT_INTERVENTION_CONFIG.contributionThreshold,
      ),
    },
  };
}

/** Non-negative (possibly fractional) minutes (NaN/empty → the fallback). */
function clampNonNegative(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/** Lower-bound a minutes value at 0.1, keeping fractions (NaN → fallback). */
function clampMinutes(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.1, value);
}

/** Clamp a 0..1 fraction from admin input (NaN/empty → the fallback). */
function clampFraction(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.01, Math.min(1, value));
}

/** Round to an integer and enforce a lower bound (NaN → the bound). */
function clampInt(value: number, min: number): number {
  const rounded = Math.round(value);
  return Number.isFinite(rounded) ? Math.max(min, rounded) : min;
}

function conditionData(condition: Condition): Prisma.ConditionRecordCreateInput {
  return {
    id: condition.id,
    name: condition.name,
    active: condition.active,
    goal: condition.goal,
    durationMinutes: condition.durationMinutes,
    groupSize: condition.groupSize,
    config: json(condition.config),
  };
}

function conditionFromRow(row: {
  id: string;
  name: string;
  active: boolean;
  goal: number;
  durationMinutes: number;
  groupSize: number;
  config: Prisma.JsonValue;
}): Condition {
  return normalizeCondition({
    id: row.id,
    name: row.name,
    active: row.active,
    goal: row.goal,
    durationMinutes: row.durationMinutes,
    groupSize: row.groupSize,
    config: fromJson<Condition["config"]>(row.config),
  });
}

function sessionFromRow(row: SessionRow): Session {
  const rankingHistory = row.rankingHistory.map(
    (entry) => fromJson<Ranking>(entry.ranking),
  );
  return {
    id: row.id,
    status: row.status as Session["status"],
    condition: fromJson<Condition>(row.conditionSnapshot),
    bot: fromJson<BotConfig>(row.bot),
    participants: row.participants.map(participantFromRow),
    chat: {
      messages: row.messages.map(messageFromRow),
    },
    briefing: fromJson<Briefing>(row.briefing),
    rankingTask: fromJson<RankingTask>(row.rankingTask),
    ranking: fromJson<Ranking>(row.ranking),
    rankingHistory,
    interventions: row.interventions.map(
      (intervention) => fromJson<InterventionLog>(intervention.payload),
    ),
    behavioralEvents: fromJson<BehavioralEvent[]>(row.behavioralEvents),
    contributionClassifications: fromJson<ContributionClassification[]>(
      row.classifications,
    ),
    processedEventIds: fromJson<string[]>(row.processedEventIds),
    runtimeState: fromJson<Record<string, unknown>>(row.runtimeState),
    polls: fromJson<Poll[]>(row.polls),
    durationMinutes: row.durationMinutes,
    roomId: row.roomId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

function participantFromRow(
  row: SessionRow["participants"][number],
): Participant {
  const entry = row.surveys.find((survey) => survey.kind === "entry");
  const exit = row.surveys.find((survey) => survey.kind === "exit");
  return {
    id: row.id,
    name: row.name,
    trackingToken: row.trackingToken,
    entrySurvey: entry ? surveyFromRow(entry) : undefined,
    exitSurvey: exit ? surveyFromRow(exit) : undefined,
  };
}

function surveyFromRow(row: SessionRow["participants"][number]["surveys"][number]): Survey {
  return {
    answers: fromJson<Survey["answers"]>(row.answers),
    submittedAt: row.submittedAt.toISOString(),
  };
}

function messageFromRow(row: SessionRow["messages"][number]): Message {
  return {
    id: row.id,
    timestamp: row.timestamp.toISOString(),
    senderId: row.senderId,
    recipientId: row.recipientId,
    text: row.text,
    reactions: row.reactions.map((reaction) => ({
      key: reaction.key,
      senderId: reaction.senderId,
      timestamp: reaction.timestamp.toISOString(),
    })),
  };
}

function sortConditions(a: Condition, b: Condition): number {
  const order = seedConditions().map((condition) => condition.id);
  const ai = order.indexOf(a.id);
  const bi = order.indexOf(b.id);
  if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toOptionalDate(value: string | undefined): Date | undefined {
  return value ? toDate(value) : undefined;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function fromJson<T>(value: Prisma.JsonValue): T {
  return value as unknown as T;
}
