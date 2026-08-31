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
  ClassificationFailure,
  CheckpointSessionRequest,
  Condition,
  ContributionClassification,
  InterventionLog,
  InterventionMode,
  Message,
  Participant,
  Poll,
  ProlificArrival,
  ProlificIdentity,
  Ranking,
  RankingTask,
  Reaction,
  RecordedReaction,
  Session,
  SessionSummary,
  StudyRound,
  StudySettings,
  Survey,
  WindowEvaluation,
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
  windowEvaluations: {
    orderBy: [{ windowIndex: "asc" }, { arm: "asc" }],
  },
} satisfies Prisma.SessionRecordInclude;

type SessionRow = Prisma.SessionRecordGetPayload<{
  include: typeof SESSION_INCLUDE;
}>;

/** A study round as stored (without the derived per-round counts). */
interface RoundState {
  id: number;
  label: string;
  startedAt: string; // ISO 8601
  endedAt?: string;
}

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
  private readonly prolificArrivals = new Map<string, ProlificArrival>();
  private readonly memoryCreds = new Map<string, MatrixCreds>();
  private readonly memorySettings: StudySettings = { compensationUrl: "" };
  private readonly memoryRounds: RoundState[] = [];
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

  /** Persist the Prolific IDs before consent/task pages can be abandoned. */
  async recordProlificArrival(
    identity: ProlificIdentity,
  ): Promise<ProlificArrival> {
    const key = `${identity.studyId}:${identity.sessionId}`;
    if (!this.dbEnabled) {
      const existing = this.prolificArrivals.get(key);
      if (existing) return existing;
      const arrival = {
        ...identity,
        arrivedAt: new Date().toISOString(),
      };
      this.prolificArrivals.set(key, arrival);
      return arrival;
    }

    await this.ensureSeeded();
    const row = await this.db.prolificArrivalRecord.upsert({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
        },
      },
      create: {
        prolificPid: identity.participantId,
        prolificStudyId: identity.studyId,
        prolificSessionId: identity.sessionId,
      },
      update: { prolificPid: identity.participantId },
    });
    return prolificArrivalFromRow(row);
  }

  async linkProlificArrival(
    identity: ProlificIdentity,
    participantRecordId: string,
  ): Promise<void> {
    const key = `${identity.studyId}:${identity.sessionId}`;
    if (!this.dbEnabled) {
      const arrival = this.prolificArrivals.get(key);
      if (arrival) arrival.participantRecordId = participantRecordId;
      return;
    }
    await this.db.prolificArrivalRecord.updateMany({
      where: {
        prolificStudyId: identity.studyId,
        prolificSessionId: identity.sessionId,
      },
      data: { participantRecordId },
    });
  }

  async listProlificArrivals(): Promise<ProlificArrival[]> {
    if (!this.dbEnabled) return [...this.prolificArrivals.values()];
    await this.ensureSeeded();
    const rows = await this.db.prolificArrivalRecord.findMany({
      orderBy: { arrivedAt: "asc" },
    });
    return rows.map(prolificArrivalFromRow);
  }

  /**
   * The study round currently open (endedAt unset). Lazily creates Round 1
   * when the table is empty (fresh DB, integration-test TRUNCATE).
   */
  async currentRound(): Promise<RoundState> {
    if (!this.dbEnabled) {
      this.seedMemory();
      const open = this.memoryRounds.find((round) => !round.endedAt);
      if (open) return open;
      const next: RoundState = {
        id: Math.max(0, ...this.memoryRounds.map((r) => r.id)) + 1,
        label: "",
        startedAt: new Date().toISOString(),
      };
      this.memoryRounds.push(next);
      return next;
    }
    await this.ensureSeeded();
    const open = await this.db.studyRoundRecord.findFirst({
      where: { endedAt: null },
    });
    if (open) return roundFromRow(open);
    const maxId = await this.db.studyRoundRecord.aggregate({
      _max: { id: true },
    });
    const created = await this.db.studyRoundRecord.create({
      data: { id: (maxId._max.id ?? 0) + 1, label: "" },
    });
    return roundFromRow(created);
  }

  /** All rounds, oldest first, with study-session counts (e2e- excluded). */
  async listRounds(): Promise<StudyRound[]> {
    const rounds = this.dbEnabled
      ? (await this.dbRounds()).map(roundFromRow)
      : [...this.memoryRounds];
    if (rounds.length === 0) rounds.push(await this.currentRound());
    if (this.dbEnabled) {
      const counts = await this.db.sessionRecord.groupBy({
        by: ["roundId", "status"],
        where: { NOT: { conditionId: { startsWith: "e2e-" } } },
        _count: { _all: true },
      });
      return rounds
        .sort((a, b) => a.id - b.id)
        .map((round) => ({
          number: round.id,
          label: round.label,
          startedAt: round.startedAt,
          endedAt: round.endedAt,
          sessionCount: counts
            .filter((row) => row.roundId === round.id && row.status !== "aborted")
            .reduce((total, row) => total + row._count._all, 0),
          completedCount:
            counts.find(
              (row) => row.roundId === round.id && row.status === "completed",
            )?._count._all ?? 0,
        }));
    }
    const sessions = this.allMemorySessions().filter(
      (session) => !session.condition.id.startsWith("e2e-"),
    );
    return rounds
      .sort((a, b) => a.id - b.id)
      .map((round) => ({
        number: round.id,
        label: round.label,
        startedAt: round.startedAt,
        endedAt: round.endedAt,
        sessionCount: sessions.filter(
          (s) => s.roundId === round.id && s.status !== "aborted",
        ).length,
        completedCount: sessions.filter(
          (s) => s.roundId === round.id && s.status === "completed",
        ).length,
      }));
  }

  /** Close the open round and open the next one. */
  async startNewRound(label: string): Promise<RoundState> {
    const current = await this.currentRound();
    const now = new Date().toISOString();
    if (!this.dbEnabled) {
      current.endedAt = now;
      const next: RoundState = {
        id: current.id + 1,
        label: label.trim(),
        startedAt: now,
      };
      this.memoryRounds.push(next);
      return next;
    }
    const created = await this.db.$transaction(async (tx) => {
      await tx.studyRoundRecord.update({
        where: { id: current.id },
        data: { endedAt: new Date(now) },
      });
      return tx.studyRoundRecord.create({
        data: { id: current.id + 1, label: label.trim() },
      });
    });
    return roundFromRow(created);
  }

  /** Rename a round; returns undefined for an unknown round number. */
  async updateRoundLabel(
    id: number,
    label: string,
  ): Promise<RoundState | undefined> {
    if (!this.dbEnabled) {
      const round = this.memoryRounds.find((r) => r.id === id);
      if (!round) return undefined;
      round.label = label.trim();
      return round;
    }
    const exists = await this.db.studyRoundRecord.findUnique({ where: { id } });
    if (!exists) return undefined;
    const updated = await this.db.studyRoundRecord.update({
      where: { id },
      data: { label: label.trim() },
    });
    return roundFromRow(updated);
  }

  private async dbRounds() {
    await this.ensureSeeded();
    return this.db.studyRoundRecord.findMany({ orderBy: { id: "asc" } });
  }

  /**
   * Sessions counting against a condition's goal in one round (everything
   * but aborted). Round-scoped so goals reset when a new round starts.
   */
  async claimedCount(conditionId: string, roundId: number): Promise<number> {
    if (!this.dbEnabled) {
      return this.allMemorySessions().filter(
        (s) =>
          s.condition.id === conditionId &&
          s.roundId === roundId &&
          s.status !== "aborted",
      ).length;
    }
    await this.ensureSeeded();
    return this.db.sessionRecord.count({
      where: {
        conditionId,
        roundId,
        status: { not: "aborted" },
      },
    });
  }

  async completedCount(conditionId: string, roundId: number): Promise<number> {
    if (!this.dbEnabled) {
      return this.allMemorySessions().filter(
        (s) =>
          s.condition.id === conditionId &&
          s.roundId === roundId &&
          s.status === "completed",
      ).length;
    }
    await this.ensureSeeded();
    return this.db.sessionRecord.count({
      where: { conditionId, roundId, status: "completed" },
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

  /**
   * Lightweight admin overview. Keep this separate from allSessions(): the
   * dashboard needs counts and timestamps, not every historical chat message,
   * reaction, ranking, intervention and model evaluation.
   */
  async listSessionSummaries(): Promise<SessionSummary[]> {
    if (!this.dbEnabled) {
      return this.allMemorySessions()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(sessionSummary);
    }
    await this.ensureSeeded();
    const rows = await this.db.sessionRecord.findMany({
      select: {
        id: true,
        status: true,
        roundId: true,
        conditionId: true,
        conditionSnapshot: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        roomId: true,
        _count: {
          select: {
            participants: true,
            messages: true,
            interventions: true,
            rankingHistory: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => {
      const condition = fromJson<Condition>(row.conditionSnapshot);
      return {
        id: row.id,
        status: row.status as SessionSummary["status"],
        roundId: row.roundId,
        conditionId: condition.id,
        conditionName: condition.name,
        participantCount: row._count.participants,
        groupSize: condition.groupSize,
        messageCount: row._count.messages,
        interventionCount: row._count.interventions,
        rankingEditCount: row._count.rankingHistory,
        createdAt: row.createdAt.toISOString(),
        startedAt: row.startedAt?.toISOString(),
        completedAt: row.completedAt?.toISOString(),
        roomId: row.roomId ?? undefined,
      };
    });
  }

  /**
   * Resolve an existing seat without hydrating every historical session.
   * Tracking tokens are indexed; the session is loaded only after a match.
   */
  async findByTrackingToken(
    token: string,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    if (!token) return undefined;
    if (!this.dbEnabled) {
      for (const session of this.allMemorySessions()) {
        if (session.status === "aborted") continue;
        const participant = session.participants.find(
          (candidate) => candidate.trackingToken === token,
        );
        if (participant) return { session, participant };
      }
      return undefined;
    }

    await this.ensureSeeded();
    const row = await this.db.participantRecord.findFirst({
      where: {
        trackingToken: token,
        session: { status: { not: "aborted" } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, sessionId: true },
    });
    if (!row) return undefined;
    const session = await this.getSession(row.sessionId);
    const participant = session?.participants.find(
      (candidate) => candidate.id === row.id,
    );
    return session && participant ? { session, participant } : undefined;
  }

  /** Constant-shape participant authorization lookup for REST endpoints. */
  async hasParticipantAccess(
    sessionId: string,
    trackingToken: string,
    participantId?: string,
  ): Promise<boolean> {
    if (!sessionId || !trackingToken) return false;
    if (!this.dbEnabled) {
      return Boolean(
        this.sessions
          .get(sessionId)
          ?.participants.some(
            (participant) =>
              participant.trackingToken === trackingToken &&
              (!participantId || participant.id === participantId),
          ),
      );
    }

    await this.ensureSeeded();
    return Boolean(
      await this.db.participantRecord.findFirst({
        where: {
          sessionId,
          trackingToken,
          ...(participantId ? { id: participantId } : {}),
        },
        select: { id: true },
      }),
    );
  }

  /** Resolve the unique Prolific submission without a full-session scan. */
  async findByProlificSession(
    identity: ProlificIdentity,
  ): Promise<{ session: Session; participant: Participant } | undefined> {
    if (!this.dbEnabled) {
      for (const session of this.allMemorySessions()) {
        const participant = session.participants.find(
          (candidate) =>
            candidate.prolific?.studyId === identity.studyId &&
            candidate.prolific.sessionId === identity.sessionId,
        );
        if (participant) return { session, participant };
      }
      return undefined;
    }

    await this.ensureSeeded();
    const row = await this.db.participantRecord.findUnique({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
        },
      },
      select: { id: true, sessionId: true },
    });
    if (!row) return undefined;
    const session = await this.getSession(row.sessionId);
    if (!session) return undefined;
    const participant = session.participants.find(
      (candidate) => candidate.id === row.id,
    );
    return participant ? { session, participant } : undefined;
  }

  /** Move an aborted Prolific seat into a new lobby without deleting its data. */
  async moveParticipant(
    participantId: string,
    fromSessionId: string,
    toSessionId: string,
  ): Promise<void> {
    if (!this.dbEnabled) {
      const source = this.sessions.get(fromSessionId);
      const target = this.sessions.get(toSessionId);
      if (!source || !target) throw new Error("Unknown session during requeue");
      const index = source.participants.findIndex(
        (participant) => participant.id === participantId,
      );
      if (index < 0) throw new Error(`Unknown participant ${participantId}`);
      source.participants.splice(index, 1);
      return;
    }

    await this.ensureSeeded();
    const moved = await this.db.participantRecord.updateMany({
      where: { id: participantId, sessionId: fromSessionId },
      data: { sessionId: toSessionId },
    });
    if (moved.count !== 1) {
      throw new Error(`Could not requeue participant ${participantId}`);
    }
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

  /** Add one reserved participant seat without touching live chat data. */
  async addParticipant(sessionId: string, participant: Participant): Promise<void> {
    if (!this.dbEnabled) {
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      if (!session.participants.some((candidate) => candidate.id === participant.id)) {
        session.participants.push(participant);
      }
      return;
    }

    await this.ensureSeeded();
    await this.db.participantRecord.create({
      data: {
        id: participant.id,
        sessionId,
        name: participant.name,
        trackingToken: participant.trackingToken,
        prolificPid: participant.prolific?.participantId,
        prolificStudyId: participant.prolific?.studyId,
        prolificSessionId: participant.prolific?.sessionId,
        completedAt: toOptionalDate(participant.completedAt),
      },
    });
  }

  /** Update only lifecycle/provisioning columns; research data is untouched. */
  async updateSessionLifecycle(
    id: string,
    patch: {
      status?: Session["status"];
      roomId?: string;
      startedAt?: string;
      completedAt?: string;
    },
  ): Promise<void> {
    if (!this.dbEnabled) {
      const session = this.sessions.get(id);
      if (!session) throw new Error(`Unknown session ${id}`);
      if (patch.status !== undefined) session.status = patch.status;
      if (patch.roomId !== undefined) session.roomId = patch.roomId;
      if (patch.startedAt !== undefined) session.startedAt = patch.startedAt;
      if (patch.completedAt !== undefined) session.completedAt = patch.completedAt;
      return;
    }
    await this.db.sessionRecord.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.roomId !== undefined ? { roomId: patch.roomId } : {}),
        ...(patch.startedAt !== undefined
          ? { startedAt: toDate(patch.startedAt) }
          : {}),
        ...(patch.completedAt !== undefined
          ? { completedAt: toDate(patch.completedAt) }
          : {}),
      },
    });
  }

  /**
   * Atomically claim a full waiting group for Matrix provisioning. Once
   * claimed, a round switch leaves it alone: the group is complete and is
   * already entering the live-session startup path.
   */
  async claimSessionProvisioning(id: string): Promise<boolean> {
    if (!this.dbEnabled) {
      const session = this.sessions.get(id);
      if (!session) return false;
      if (session.status === "waiting") session.status = "provisioning";
      return session.status === "provisioning";
    }
    const claimed = await this.db.sessionRecord.updateMany({
      where: { id, status: "waiting" },
      data: { status: "provisioning" },
    });
    if (claimed.count > 0) return true;
    const current = await this.db.sessionRecord.findUnique({
      where: { id },
      select: { status: true },
    });
    return current?.status === "provisioning";
  }

  /** Publish a fully prepared room without resurrecting an aborted session. */
  async finishSessionProvisioning(
    id: string,
    roomId: string,
    startedAt: string,
  ): Promise<boolean> {
    if (!this.dbEnabled) {
      const session = this.sessions.get(id);
      if (!session) return false;
      if (session.status === "running") return session.roomId === roomId;
      if (session.status !== "provisioning") return false;
      session.roomId = roomId;
      session.status = "running";
      session.startedAt = startedAt;
      return true;
    }
    const transitioned = await this.db.sessionRecord.updateMany({
      where: { id, status: "provisioning" },
      data: {
        roomId,
        status: "running",
        startedAt: toDate(startedAt),
      },
    });
    if (transitioned.count > 0) return true;
    const current = await this.db.sessionRecord.findUnique({
      where: { id },
      select: { status: true, roomId: true },
    });
    return current?.status === "running" && current.roomId === roomId;
  }

  /** Persist one survey independently from the live session snapshot. */
  async saveParticipantSurvey(
    sessionId: string,
    participantId: string,
    kind: "entry" | "exit",
    survey: Survey,
  ): Promise<boolean> {
    if (!this.dbEnabled) {
      const participant = this.sessions
        .get(sessionId)
        ?.participants.find((candidate) => candidate.id === participantId);
      if (!participant) return false;
      if (kind === "entry") participant.entrySurvey = survey;
      else participant.exitSurvey = survey;
      return true;
    }

    const participant = await this.db.participantRecord.findFirst({
      where: { id: participantId, sessionId },
      select: { id: true },
    });
    if (!participant) return false;
    await this.db.surveyRecord.upsert({
      where: { participantId_kind: { participantId, kind } },
      create: {
        participantId,
        kind,
        answers: json(survey.answers),
        submittedAt: toDate(survey.submittedAt),
      },
      update: {
        answers: json(survey.answers),
        submittedAt: toDate(survey.submittedAt),
      },
    });
    return true;
  }

  /** Merge additional keys into an existing exit survey's answers JSON. */
  async patchExitSurveyAnswers(
    sessionId: string,
    participantId: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.dbEnabled) {
      const participant = this.sessions
        .get(sessionId)
        ?.participants.find((candidate) => candidate.id === participantId);
      if (!participant?.exitSurvey) return false;
      Object.assign(participant.exitSurvey.answers, patch);
      return true;
    }

    const existing = await this.db.surveyRecord.findUnique({
      where: { participantId_kind: { participantId, kind: "exit" } },
      select: { answers: true },
    });
    if (!existing) return false;
    const merged = { ...(existing.answers as Record<string, unknown>), ...patch };
    await this.db.surveyRecord.update({
      where: { participantId_kind: { participantId, kind: "exit" } },
      data: { answers: json(merged) },
    });
    return true;
  }

  /** Mark one participant complete without rewriting their session. */
  async markParticipantCompleted(
    sessionId: string,
    participantId: string,
    completedAt: string,
  ): Promise<boolean> {
    if (!this.dbEnabled) {
      const participant = this.sessions
        .get(sessionId)
        ?.participants.find((candidate) => candidate.id === participantId);
      if (!participant) return false;
      participant.completedAt ??= completedAt;
      return true;
    }
    const result = await this.db.participantRecord.updateMany({
      where: { id: participantId, sessionId, completedAt: null },
      data: { completedAt: toDate(completedAt) },
    });
    if (result.count > 0) return true;
    return Boolean(
      await this.db.participantRecord.findFirst({
        where: { id: participantId, sessionId },
        select: { id: true },
      }),
    );
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
          roundId: session.roundId,
          conditionSnapshot: json(session.condition),
          bot: json(session.bot),
          briefing: json(session.briefing),
          rankingTask: json(session.rankingTask),
          ranking: json(session.ranking),
          polls: json(session.polls),
          behavioralEvents: json(session.behavioralEvents),
          classifications: json(session.contributionClassifications),
          classificationFailures: json(session.classificationFailures ?? []),
          processedEventIds: json(session.processedEventIds ?? []),
          runtimeState: json(session.runtimeState ?? {}),
          checkpointRevision: session.checkpointRevision ?? 0,
          durationMinutes: session.durationMinutes,
          roomId: session.roomId,
          createdAt: toDate(session.createdAt),
          startedAt: toOptionalDate(session.startedAt),
          completedAt: toOptionalDate(session.completedAt),
        },
        update: {
          status: session.status,
          conditionId: session.condition.id,
          roundId: session.roundId,
          conditionSnapshot: json(session.condition),
          bot: json(session.bot),
          briefing: json(session.briefing),
          rankingTask: json(session.rankingTask),
          polls: json(session.polls),
          durationMinutes: session.durationMinutes,
          roomId: session.roomId,
          startedAt: toOptionalDate(session.startedAt),
          ...(session.completedAt
            ? { completedAt: toDate(session.completedAt) }
            : {}),
        },
      });

      await this.saveParticipants(tx, session);
      await this.persistRuntimeCheckpoint(
        tx,
        session.id,
        checkpointFromSession(session),
      );
    });
  }

  /**
   * Persist only live chat-owned fields; never overwrite lifecycle/surveys.
   * Collections are append/upserted rather than deleted and recreated, so a
   * stale or interrupted checkpoint cannot erase previously committed data.
   */
  async saveRuntimeCheckpoint(
    sessionId: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<void> {
    if (!this.dbEnabled) {
      const stored = this.sessions.get(sessionId);
      if (!stored) throw new Error(`Unknown session ${sessionId}`);
      mergeCheckpointIntoSession(stored, checkpoint);
      return;
    }

    await this.db.$transaction(async (tx) => {
      await this.persistRuntimeCheckpoint(tx, sessionId, checkpoint);
    }, {
      // The default interactive-transaction timeout is five seconds. During a
      // recruitment wave, waiting briefly for a connection is safer than
      // expiring an otherwise healthy monotonic checkpoint transaction.
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  /** The oldest active, still-forming CURRENT-ROUND session with a free seat. */
  async findForming(conditionId?: string): Promise<Session | undefined> {
    const current = await this.currentRound();
    const sessions = this.dbEnabled
      ? await this.waitingSessionsFromDb(current.id, conditionId)
      : this.allMemorySessions().filter((session) => {
          const currentCondition = this.conditions.find(
            (condition) => condition.id === session.condition.id,
          );
          return (
            session.status === "waiting" &&
            session.roundId === current.id &&
            currentCondition?.active === true &&
            (!conditionId || session.condition.id === conditionId)
          );
        });
    return sessions
      .filter(
        (s) =>
          s.roundId === current.id &&
          s.participants.length < s.condition.groupSize,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  /**
   * Abort waiting lobbies in one targeted update. With `olderThan`, also clean
   * up a provisioning group that has been unable to start for the full lobby
   * timeout. Rows are retained for audit/export; only lifecycle state changes.
   */
  async abortWaitingSessions(
    olderThan?: Date,
  ): Promise<Array<{ id: string; createdAt: string; participantCount: number }>> {
    if (!this.dbEnabled) {
      const aborted: Array<{
        id: string;
        createdAt: string;
        participantCount: number;
      }> = [];
      for (const session of this.sessions.values()) {
        const abortableStatus = olderThan
          ? session.status === "waiting" || session.status === "provisioning"
          : session.status === "waiting";
        if (
          !abortableStatus ||
          (olderThan && new Date(session.createdAt) >= olderThan)
        ) {
          continue;
        }
        session.status = "aborted";
        aborted.push({
          id: session.id,
          createdAt: session.createdAt,
          participantCount: session.participants.length,
        });
      }
      return aborted;
    }

    await this.ensureSeeded();
    const abortableStatuses = olderThan
      ? ["waiting", "provisioning"]
      : ["waiting"];
    const rows = await this.db.sessionRecord.findMany({
      where: {
        status: { in: abortableStatuses },
        ...(olderThan ? { createdAt: { lt: olderThan } } : {}),
      },
      select: {
        id: true,
        createdAt: true,
        _count: { select: { participants: true } },
      },
    });
    if (rows.length > 0) {
      await this.db.sessionRecord.updateMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          status: { in: abortableStatuses },
        },
        data: { status: "aborted" },
      });
    }
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      participantCount: row._count.participants,
    }));
  }

  /** Running sessions only, for Chat Service crash recovery. */
  async runningSessions(): Promise<Session[]> {
    if (!this.dbEnabled) {
      return this.allMemorySessions().filter(
        (session) => session.status === "running" && Boolean(session.roomId),
      );
    }
    await this.ensureSeeded();
    const rows = await this.db.sessionRecord.findMany({
      where: { status: "running", roomId: { not: null } },
      include: SESSION_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(sessionFromRow);
  }

  async createForming(condition: Condition): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      status: "waiting",
      // Stamped once from the open round; the session never changes rounds.
      roundId: (await this.currentRound()).id,
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
      windowEvaluations: [],
      classificationFailures: [],
      processedEventIds: [],
      redactedReactionEventIds: [],
      reactionEvents: [],
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
      // Mirror the DB column so exports can match messages to participants.
      for (const session of this.sessions.values()) {
        const participant = session.participants.find(
          (p) => p.id === participantId,
        );
        if (participant) participant.matrixUserId = creds.userId;
      }
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
    this.memoryRounds.push({
      id: 1,
      label: "",
      startedAt: new Date().toISOString(),
    });
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

  private async waitingSessionsFromDb(
    roundId: number,
    conditionId?: string,
  ): Promise<Session[]> {
    await this.ensureSeeded();
    const rows = await this.db.sessionRecord.findMany({
      where: {
        status: "waiting",
        roundId,
        condition: { active: true },
        ...(conditionId ? { conditionId } : {}),
      },
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
          prolificPid: participant.prolific?.participantId,
          prolificStudyId: participant.prolific?.studyId,
          prolificSessionId: participant.prolific?.sessionId,
          completedAt: toOptionalDate(participant.completedAt),
        },
        update: {
          sessionId: session.id,
          name: participant.name,
          trackingToken: participant.trackingToken,
          prolificPid: participant.prolific?.participantId,
          prolificStudyId: participant.prolific?.studyId,
          prolificSessionId: participant.prolific?.sessionId,
          // A stale aggregate snapshot must never clear compensation
          // eligibility written independently by completeParticipant().
          ...(participant.completedAt
            ? { completedAt: toDate(participant.completedAt) }
            : {}),
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

  /**
   * Merge a full Chat Service snapshot into normalized research tables.
   * Every operation is idempotent. No message/ranking/intervention row is
   * deleted, which makes retrying after a timeout safe and crash-resilient.
   */
  private async persistRuntimeCheckpoint(
    tx: Prisma.TransactionClient,
    sessionId: string,
    checkpoint: CheckpointSessionRequest,
  ): Promise<void> {
    const current = await tx.sessionRecord.findUnique({
      where: { id: sessionId },
      select: {
        ranking: true,
        rankingHistory: {
          select: { position: true, ranking: true },
          orderBy: { position: "asc" },
        },
        behavioralEvents: true,
        classifications: true,
        classificationFailures: true,
        processedEventIds: true,
        runtimeState: true,
        checkpointRevision: true,
      },
    });
    if (!current) throw new Error(`Unknown session ${sessionId}`);
    const incomingRevision = checkpoint.revision;
    const acceptsMutableState =
      incomingRevision === undefined ||
      incomingRevision >= current.checkpointRevision;

    const messages = checkpoint.messages ?? [];
    if (messages.length > 0) {
      await tx.messageRecord.createMany({
        data: messages.map((message) => ({
          id: message.id,
          sessionId,
          timestamp: toDate(message.timestamp),
          senderId: message.senderId,
          recipientId: message.recipientId ?? null,
          text: message.text,
        })),
        skipDuplicates: true,
      });

      // New checkpoints carry the immutable Matrix annotation event id. Keep
      // legacy semantic matching only to upgrade pre-migration active rows.
      const messageIds = messages.map((message) => message.id);
      const existingReactions = await tx.reactionRecord.findMany({
        where: { messageId: { in: messageIds } },
        select: {
          id: true,
          eventId: true,
          messageId: true,
          key: true,
          senderId: true,
        },
      });
      const seenEventIds = new Set(
        existingReactions.flatMap((reaction) =>
          reaction.eventId ? [reaction.eventId] : [],
        ),
      );
      const legacyByKey = new Map(
        existingReactions
          .filter((reaction) => !reaction.eventId)
          .map((reaction) => [
            reactionKey(reaction.messageId, reaction.key, reaction.senderId),
            reaction.id,
          ]),
      );
      const legacySeen = new Set(legacyByKey.keys());
      const reactions: Prisma.ReactionRecordCreateManyInput[] = [];
      for (const message of messages) {
        for (const reaction of message.reactions) {
          const key = reactionKey(message.id, reaction.key, reaction.senderId);
          if (reaction.eventId) {
            if (seenEventIds.has(reaction.eventId)) continue;
            const legacyId = legacyByKey.get(key);
            if (legacyId) {
              await tx.reactionRecord.update({
                where: { id: legacyId },
                data: { eventId: reaction.eventId },
              });
              legacyByKey.delete(key);
            } else {
              reactions.push({
                eventId: reaction.eventId,
                messageId: message.id,
                key: reaction.key,
                senderId: reaction.senderId,
                timestamp: toDate(reaction.timestamp),
              });
            }
            seenEventIds.add(reaction.eventId);
            continue;
          }
          if (legacySeen.has(key)) continue;
          legacySeen.add(key);
          reactions.push({
            messageId: message.id,
            key: reaction.key,
            senderId: reaction.senderId,
            timestamp: toDate(reaction.timestamp),
          });
        }
      }
      if (reactions.length > 0) {
        await tx.reactionRecord.createMany({ data: reactions, skipDuplicates: true });
      }
    }

    const reactionEvents = checkpoint.reactionEvents ?? [];
    if (reactionEvents.length > 0) {
      await tx.reactionRecord.createMany({
        data: reactionEvents.map((reaction) => ({
          eventId: reaction.eventId,
          messageId: reaction.messageId,
          key: reaction.key,
          senderId: reaction.senderId,
          timestamp: toDate(reaction.timestamp),
          redacted: reaction.redacted,
          redactionEventId: reaction.redactionEventId,
          redactedAt: toOptionalDate(reaction.redactedAt),
        })),
        skipDuplicates: true,
      });
      // Redaction is monotonic. Never let a late active snapshot resurrect a
      // reaction event that a newer checkpoint has already marked inactive.
      for (const reaction of reactionEvents) {
        if (!reaction.redacted) continue;
        await tx.reactionRecord.updateMany({
          where: { eventId: reaction.eventId },
          data: {
            redacted: true,
            ...(reaction.redactionEventId
              ? { redactionEventId: reaction.redactionEventId }
              : {}),
            ...(reaction.redactedAt
              ? { redactedAt: toDate(reaction.redactedAt) }
              : {}),
          },
        });
      }
    }
    const redactedReactionEventIds = checkpoint.redactedReactionEventIds ?? [];
    if (redactedReactionEventIds.length > 0) {
      await tx.reactionRecord.updateMany({
        where: { eventId: { in: redactedReactionEventIds } },
        data: { redacted: true },
      });
    }

    const rankingHistory = checkpoint.rankingHistory ?? [];
    const storedRankings = current.rankingHistory.map((entry) =>
      fromJson<Ranking>(entry.ranking),
    );
    const seenRankings = new Set(storedRankings.map(rankingKey));
    const newRankings = rankingHistory.filter((ranking) => {
      const key = rankingKey(ranking);
      if (seenRankings.has(key)) return false;
      seenRankings.add(key);
      return true;
    });
    if (newRankings.length > 0) {
      const nextPosition =
        Math.max(-1, ...current.rankingHistory.map((entry) => entry.position)) + 1;
      await tx.rankingHistoryRecord.createMany({
        data: newRankings.map((ranking, offset) => ({
          sessionId,
          position: nextPosition + offset,
          ranking: json(ranking),
          updatedAt: toDate(ranking.updatedAt),
        })),
      });
    }

    const interventions = checkpoint.interventions ?? [];
    if (interventions.length > 0) {
      await tx.interventionRecord.createMany({
        data: interventions.map((intervention) => ({
          id: intervention.id,
          sessionId,
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
        })),
        skipDuplicates: true,
      });
    }

    const evaluations = checkpoint.windowEvaluations ?? [];
    if (evaluations.length > 0) {
      await tx.windowEvaluationRecord.createMany({
        data: evaluations.map((evaluation) => ({
          id: evaluation.id,
          sessionId,
          conditionId: evaluation.conditionId,
          arm: evaluation.arm,
          windowIndex: evaluation.windowIndex,
          windowStart: toDate(evaluation.windowStart),
          windowEnd: toDate(evaluation.windowEnd),
          outcome: evaluation.outcome,
          llmMode: evaluation.llmMode,
          payload: json(evaluation),
        })),
        skipDuplicates: true,
      });
    }

    const currentBehavior = fromJson<BehavioralEvent[]>(current.behavioralEvents);
    const currentClassifications = fromJson<ContributionClassification[]>(
      current.classifications,
    );
    const currentFailures = fromJson<ClassificationFailure[]>(
      current.classificationFailures,
    );
    const currentProcessed = fromJson<string[]>(current.processedEventIds);
    const currentRuleState = fromJson<Record<string, unknown>>(current.runtimeState);
    const latestRanking =
      incomingRevision !== undefined
        ? (rankingHistory.at(-1) ?? fromJson<Ranking>(current.ranking))
        : storedRankings.length === 0
          ? (rankingHistory.at(-1) ?? fromJson<Ranking>(current.ranking))
          : newestRanking(fromJson<Ranking>(current.ranking), ...rankingHistory);

    await tx.sessionRecord.update({
      where: { id: sessionId },
      data: {
        ...(acceptsMutableState && rankingHistory.length > 0
          ? { ranking: json(latestRanking) }
          : {}),
        behavioralEvents: json(
          mergeCheckpointValues(
            currentBehavior,
            checkpoint.behavioralEvents ?? [],
            (event) => event.id,
            acceptsMutableState,
          ),
        ),
        classifications: json(
          mergeCheckpointValues(
            currentClassifications,
            checkpoint.contributionClassifications ?? [],
            (classification) => classification.messageId,
            acceptsMutableState,
          ),
        ),
        classificationFailures: json(
          mergeCheckpointValues(
            currentFailures,
            checkpoint.classificationFailures ?? [],
            (failure) => failure.messageId,
            acceptsMutableState,
          ),
        ),
        processedEventIds: json([
          ...new Set([...currentProcessed, ...(checkpoint.processedEventIds ?? [])]),
        ]),
        runtimeState: acceptsMutableState
          ? json({
              ...currentRuleState,
              ...checkpoint.ruleState,
            })
          : json(currentRuleState),
        ...(acceptsMutableState && incomingRevision !== undefined
          ? { checkpointRevision: incomingRevision }
          : {}),
      },
    });
  }
}

function checkpointFromSession(session: Session): CheckpointSessionRequest {
  return {
    revision: session.checkpointRevision,
    messages: session.chat.messages,
    rankingHistory: session.rankingHistory ?? [],
    interventions: session.interventions,
    behavioralEvents: session.behavioralEvents,
    contributionClassifications: session.contributionClassifications,
    windowEvaluations: session.windowEvaluations ?? [],
    classificationFailures: session.classificationFailures ?? [],
    processedEventIds: session.processedEventIds ?? [],
    redactedReactionEventIds: session.redactedReactionEventIds ?? [],
    reactionEvents: session.reactionEvents ?? [],
    ruleState: session.runtimeState ?? {},
  };
}

/** In-memory equivalent of the durable, monotonic checkpoint merge. */
function mergeCheckpointIntoSession(
  session: Session,
  checkpoint: CheckpointSessionRequest,
): void {
  const incomingRevision = checkpoint.revision;
  const acceptsMutableState =
    incomingRevision === undefined ||
    incomingRevision >= (session.checkpointRevision ?? 0);
  const hadRankingHistory = (session.rankingHistory?.length ?? 0) > 0;
  session.reactionEvents = mergeRecordedReactions(
    session.reactionEvents ?? [],
    checkpoint.reactionEvents ?? [],
  );
  const redactedReactionEventIds = new Set([
    ...(session.redactedReactionEventIds ?? []),
    ...(checkpoint.redactedReactionEventIds ?? []),
    ...session.reactionEvents
      .filter((reaction) => reaction.redacted)
      .map((reaction) => reaction.eventId),
  ]);
  session.redactedReactionEventIds = [...redactedReactionEventIds];
  session.chat.messages = mergeMessages(
    session.chat.messages,
    checkpoint.messages ?? [],
    redactedReactionEventIds,
  );
  session.rankingHistory = appendUnique(
    session.rankingHistory ?? [],
    checkpoint.rankingHistory ?? [],
    rankingKey,
  );
  session.interventions = mergeByKey(
    session.interventions,
    checkpoint.interventions ?? [],
    (intervention) => intervention.id,
  );
  session.behavioralEvents = mergeCheckpointValues(
    session.behavioralEvents,
    checkpoint.behavioralEvents ?? [],
    (event) => event.id,
    acceptsMutableState,
  );
  session.contributionClassifications = mergeCheckpointValues(
    session.contributionClassifications,
    checkpoint.contributionClassifications ?? [],
    (classification) => classification.messageId,
    acceptsMutableState,
  );
  session.windowEvaluations = mergeByKey(
    session.windowEvaluations ?? [],
    checkpoint.windowEvaluations ?? [],
    (evaluation) => evaluation.id,
  );
  session.classificationFailures = mergeCheckpointValues(
    session.classificationFailures ?? [],
    checkpoint.classificationFailures ?? [],
    (failure) => failure.messageId,
    acceptsMutableState,
  );
  session.processedEventIds = [
    ...new Set([
      ...(session.processedEventIds ?? []),
      ...(checkpoint.processedEventIds ?? []),
    ]),
  ];
  if (acceptsMutableState) {
    session.runtimeState = {
      ...session.runtimeState,
      ...checkpoint.ruleState,
    };
    if (incomingRevision !== undefined) {
      session.checkpointRevision = incomingRevision;
    }
  }
  if (
    acceptsMutableState &&
    (checkpoint.rankingHistory?.length ?? 0) > 0
  ) {
    session.ranking =
      incomingRevision !== undefined || !hadRankingHistory
        ? checkpoint.rankingHistory!.at(-1)!
        : newestRanking(session.ranking, ...(checkpoint.rankingHistory ?? []));
  }
}

function mergeMessages(
  existing: Message[],
  incoming: Message[],
  redactedReactionEventIds: ReadonlySet<string>,
): Message[] {
  const merged = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) {
    const current = merged.get(message.id);
    if (!current) {
      merged.set(message.id, {
        ...message,
        reactions: message.reactions.filter(
          (reaction) =>
            !reaction.eventId ||
            !redactedReactionEventIds.has(reaction.eventId),
        ),
      });
      continue;
    }
    const seenReactions = new Set(
      current.reactions
        .filter(
          (reaction) =>
            !reaction.eventId ||
            !redactedReactionEventIds.has(reaction.eventId),
        )
        .map((reaction) => reactionIdentityKey(message.id, reaction)),
    );
    const reactions = current.reactions.filter(
      (reaction) =>
        !reaction.eventId ||
        !redactedReactionEventIds.has(reaction.eventId),
    );
    for (const reaction of message.reactions) {
      if (
        reaction.eventId &&
        redactedReactionEventIds.has(reaction.eventId)
      ) {
        continue;
      }
      const key = reactionIdentityKey(message.id, reaction);
      if (seenReactions.has(key)) continue;
      seenReactions.add(key);
      reactions.push(reaction);
    }
    merged.set(message.id, { ...current, reactions });
  }
  return [...merged.values()];
}

function mergeRecordedReactions(
  existing: RecordedReaction[],
  incoming: RecordedReaction[],
): RecordedReaction[] {
  const merged = new Map(existing.map((reaction) => [reaction.eventId, reaction]));
  for (const reaction of incoming) {
    const current = merged.get(reaction.eventId);
    if (!current) {
      merged.set(reaction.eventId, reaction);
      continue;
    }
    merged.set(reaction.eventId, {
      ...current,
      ...reaction,
      redacted: current.redacted || reaction.redacted,
      redactionEventId:
        reaction.redactionEventId ?? current.redactionEventId,
      redactedAt: reaction.redactedAt ?? current.redactedAt,
    });
  }
  return [...merged.values()];
}

function reactionIdentityKey(messageId: string, reaction: Reaction): string {
  return reaction.eventId
    ? `event:${reaction.eventId}`
    : reactionKey(messageId, reaction.key, reaction.senderId);
}

function appendUnique<T>(
  existing: T[],
  incoming: T[],
  key: (item: T) => string,
): T[] {
  const seen = new Set(existing.map(key));
  const appended = [...existing];
  for (const item of incoming) {
    const itemKey = key(item);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    appended.push(item);
  }
  return appended;
}

function rankingKey(ranking: Ranking): string {
  if (ranking.eventId) return `event:${ranking.eventId}`;
  const movement = ranking.movement
    ? `${ranking.movement.itemId}:${ranking.movement.from}:${ranking.movement.to}`
    : "";
  return [
    ranking.taskId,
    ranking.updatedAt,
    ranking.updatedBy,
    ranking.order.join("\u0001"),
    movement,
  ].join("\u0000");
}

function newestRanking(first: Ranking, ...rest: Ranking[]): Ranking {
  return rest.reduce((latest, candidate) => {
    const latestTime = Date.parse(latest.updatedAt);
    const candidateTime = Date.parse(candidate.updatedAt);
    if (!Number.isFinite(candidateTime)) return latest;
    if (!Number.isFinite(latestTime) || candidateTime >= latestTime) {
      return candidate;
    }
    return latest;
  }, first);
}

/**
 * Newer snapshots may replace a value with the same logical key (for example
 * a retried classification). A late snapshot may only contribute previously
 * unseen records; it cannot roll a newer value back.
 */
function mergeCheckpointValues<T>(
  existing: T[],
  incoming: T[],
  key: (item: T) => string,
  acceptsReplacement: boolean,
): T[] {
  return acceptsReplacement
    ? mergeByKey(existing, incoming, (item) => key(item))
    : appendUnique(existing, incoming, key);
}

function mergeByKey<T>(
  existing: T[],
  incoming: T[],
  key: (item: T, index: number) => string,
): T[] {
  const merged = new Map<string, T>();
  existing.forEach((item, index) => merged.set(key(item, index), item));
  incoming.forEach((item, index) => merged.set(key(item, index), item));
  return [...merged.values()];
}

function reactionKey(messageId: string, key: string, senderId: string): string {
  return `${messageId}\u0000${key}\u0000${senderId}`;
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
    id: String(condition.id ?? "").trim().slice(0, 128),
    name: String(condition.name ?? "").trim().slice(0, 160),
    active: condition.active === true,
    goal: clampInt(condition.goal, 0, 100_000),
    durationMinutes: clampInt(condition.durationMinutes, 1, 240),
    groupSize: clampInt(condition.groupSize, 2, 50),
    config: {
      ...DEFAULT_INTERVENTION_CONFIG,
      ...condition.config,
      // Conditions stored before the tone axis was retired carry old mode
      // strings like "public-engaging" — fold them onto the delivery axis.
      interventionMode: normalizeInterventionMode(
        condition.config.interventionMode ??
          DEFAULT_INTERVENTION_CONFIG.interventionMode,
      ),
      // External iframe support is opt-in. Old, missing or malformed values
      // always retain the existing structured ranking workspace.
      workspaceMode:
        condition.config.workspaceMode === "external" ? "external" : "ranking",
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
        240,
      ),
      // Fractional minutes allowed (pilots/tests use sub-minute windows).
      contributionWindowMinutes: clampMinutes(
        condition.config.contributionWindowMinutes ??
          DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
        DEFAULT_INTERVENTION_CONFIG.contributionWindowMinutes,
        240,
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
function clampNonNegative(
  value: number,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(maximum, value));
}

/** Lower-bound a minutes value at 0.1, keeping fractions (NaN → fallback). */
function clampMinutes(
  value: number,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.1, Math.min(maximum, value));
}

/** Clamp a 0..1 fraction from admin input (NaN/empty → the fallback). */
function clampFraction(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0.01, Math.min(1, value));
}

/** Round to an integer and enforce a lower bound (NaN → the bound). */
function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Number.isFinite(rounded)
    ? Math.max(min, Math.min(max, rounded))
    : min;
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
    roundId: row.roundId,
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
    windowEvaluations: row.windowEvaluations.map(
      (evaluation) => fromJson<WindowEvaluation>(evaluation.payload),
    ),
    classificationFailures: fromJson<ClassificationFailure[]>(
      row.classificationFailures,
    ),
    processedEventIds: fromJson<string[]>(row.processedEventIds),
    redactedReactionEventIds: row.messages.flatMap((message) =>
      message.reactions.flatMap((reaction) =>
        reaction.redacted && reaction.eventId ? [reaction.eventId] : [],
      ),
    ),
    reactionEvents: row.messages.flatMap((message) =>
      message.reactions.flatMap((reaction) =>
        reaction.eventId
          ? [
              {
                eventId: reaction.eventId,
                messageId: message.id,
                key: reaction.key,
                senderId: reaction.senderId,
                timestamp: reaction.timestamp.toISOString(),
                redacted: reaction.redacted,
                redactionEventId: reaction.redactionEventId ?? undefined,
                redactedAt: reaction.redactedAt?.toISOString(),
              },
            ]
          : [],
      ),
    ),
    runtimeState: fromJson<Record<string, unknown>>(row.runtimeState),
    checkpointRevision: row.checkpointRevision,
    polls: fromJson<Poll[]>(row.polls),
    durationMinutes: row.durationMinutes,
    roomId: row.roomId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  };
}

function sessionSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    status: session.status,
    roundId: session.roundId,
    conditionId: session.condition.id,
    conditionName: session.condition.name,
    participantCount: session.participants.length,
    groupSize: session.condition.groupSize,
    messageCount: session.chat.messages.length,
    interventionCount: session.interventions.length,
    rankingEditCount: session.rankingHistory?.length ?? 0,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    roomId: session.roomId,
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
    prolific:
      row.prolificPid && row.prolificStudyId && row.prolificSessionId
        ? {
            participantId: row.prolificPid,
            studyId: row.prolificStudyId,
            sessionId: row.prolificSessionId,
          }
        : undefined,
    completedAt: row.completedAt?.toISOString(),
    matrixUserId: row.matrixUserId ?? undefined,
    entrySurvey: entry ? surveyFromRow(entry) : undefined,
    exitSurvey: exit ? surveyFromRow(exit) : undefined,
  };
}

function prolificArrivalFromRow(row: {
  prolificPid: string;
  prolificStudyId: string;
  prolificSessionId: string;
  participantRecordId: string | null;
  arrivedAt: Date;
}): ProlificArrival {
  return {
    participantId: row.prolificPid,
    studyId: row.prolificStudyId,
    sessionId: row.prolificSessionId,
    participantRecordId: row.participantRecordId ?? undefined,
    arrivedAt: row.arrivedAt.toISOString(),
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
    reactions: row.reactions
      .filter((reaction) => !reaction.redacted)
      .map((reaction) => ({
        ...(reaction.eventId ? { eventId: reaction.eventId } : {}),
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

function roundFromRow(row: {
  id: number;
  label: string;
  startedAt: Date;
  endedAt: Date | null;
}): RoundState {
  return {
    id: row.id,
    label: row.label,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString(),
  };
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
