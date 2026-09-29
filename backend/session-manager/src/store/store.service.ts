import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TEST_CONDITION_PREFIX, isTestCondition } from "@gdm/shared";
import type {
  CheckpointSessionRequest,
  Condition,
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationStage,
  Participant,
  ProlificArrival,
  ProlificIdentity,
  Session,
  SessionSummary,
  StudyRound,
  StudySettings,
  Survey,
} from "@gdm/shared";
import type { MatrixCreds } from "../matrix/matrix.service";
import { PrismaService } from "../prisma/prisma.service";
import { mergeCheckpointIntoSession } from "./checkpoint-merge";
import { normalizeCondition, seedConditions, sortConditions } from "./conditions";
import { newFormingSession } from "./forming-session";
import type { TerminationCompensation } from "./participation";
import { ParticipationStore } from "./participation.store";
import { json, toDate } from "./prisma-values";
import {
  SESSION_INCLUDE,
  SESSION_SUMMARY_SELECT,
  conditionData,
  conditionFromRow,
  participantCreateData,
  roundFromRow,
  sessionFromRow,
  sessionSummary,
  sessionSummaryFromRow,
  type RoundState,
} from "./row-mappers";
import { persistRuntimeCheckpoint } from "./runtime-checkpoint";
import { persistSessionSnapshot, upsertSurvey } from "./session-snapshot";

const EMPTY_STUDY_SETTINGS: StudySettings = {
  compensationUrl: "",
  noConsentUrl: "",
  ineligibleUrl: "",
  withdrawalUrl: "",
  unmatchedUrl: "",
  technicalFailureUrl: "",
};

/** A lobby aborted by the store, with the status it had before. */
export interface AbortedLobby {
  id: string;
  createdAt: string;
  participantCount: number;
  priorStatus: "waiting" | "provisioning";
}

/**
 * Persistence boundary for study state.
 *
 * Docker/local stack uses Postgres through Prisma when DATABASE_URL is set.
 * Unit tests and ad-hoc non-DB runs fall back to the same in-memory behavior
 * the app previously used, keeping test setup light while making Docker data
 * durable across backend restarts.
 *
 * Prolific participation outcomes live in ParticipationStore; row mapping,
 * condition normalization and the checkpoint merge are pure sibling modules.
 */
@Injectable()
export class StoreService implements OnModuleInit {
  private readonly conditions: Condition[] = [];
  private readonly sessions = new Map<string, Session>();
  private readonly memoryCreds = new Map<string, MatrixCreds>();
  private readonly memorySettings: StudySettings = { ...EMPTY_STUDY_SETTINGS };
  private readonly memoryRounds: RoundState[] = [];
  private readonly participation: ParticipationStore;
  private seedPromise?: Promise<void>;

  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.participation = new ParticipationStore({
      dbEnabled: () => this.dbEnabled,
      db: () => this.db,
      ensureSeeded: () => this.ensureSeeded(),
    });
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

  /** Creation time (ISO) per condition id; empty without a database. */
  async conditionCreatedAt(): Promise<Map<string, string>> {
    if (!this.dbEnabled) return new Map();
    await this.ensureSeeded();
    const rows = await this.db.conditionRecord.findMany({
      select: { id: true, createdAt: true },
    });
    return new Map(rows.map((row) => [row.id, row.createdAt.toISOString()]));
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
    return Object.fromEntries(
      Object.keys(EMPTY_STUDY_SETTINGS).map((key) => [key, byKey.get(key) ?? ""]),
    ) as unknown as StudySettings;
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

  // ── Prolific participation (ParticipationStore) ──────────────────

  /** Persist the Prolific IDs before consent/task pages can be abandoned. */
  recordProlificArrival(identity: ProlificIdentity): Promise<ProlificArrival> {
    return this.participation.recordProlificArrival(identity);
  }

  getProlificArrival(
    identity: ProlificIdentity,
  ): Promise<ProlificArrival | undefined> {
    return this.participation.getProlificArrival(identity);
  }

  /** Active Prolific arrivals whose browser has stopped sending heartbeats. */
  listStaleProlificArrivals(
    cutoff: Date,
    limit?: number,
  ): Promise<ProlificArrival[]> {
    return this.participation.listStaleProlificArrivals(cutoff, limit);
  }

  /** Advance a server-validated journey milestone; terminal outcomes are immutable. */
  recordParticipationStage(
    identity: ProlificIdentity,
    stage: Exclude<ParticipationStage, "done" | "terminated">,
  ): Promise<ProlificArrival> {
    return this.participation.recordParticipationStage(identity, stage);
  }

  /** Atomically persist one terminal outcome and its idempotent Prolific action. */
  terminateProlificParticipation(
    identity: ProlificIdentity,
    outcome: Exclude<ParticipationOutcome, "completed">,
    reason: string,
    compensationKind: TerminationCompensation,
    compensationAmountPence?: number,
  ): Promise<ParticipationOutcomeRecord> {
    return this.participation.terminateProlificParticipation(
      identity,
      outcome,
      reason,
      compensationKind,
      compensationAmountPence,
    );
  }

  /** Claim a stale heartbeat atomically (a racing heartbeat wins). */
  terminateStaleProlificParticipation(
    identity: ProlificIdentity,
    cutoff: Date,
    outcome: Exclude<ParticipationOutcome, "completed">,
    reason: string,
    compensationKind: TerminationCompensation,
    compensationAmountPence?: number,
  ): Promise<ParticipationOutcomeRecord | null> {
    return this.participation.terminateStaleProlificParticipation(
      identity,
      cutoff,
      outcome,
      reason,
      compensationKind,
      compensationAmountPence,
    );
  }

  completeProlificParticipation(
    identity: ProlificIdentity,
  ): Promise<ParticipationOutcomeRecord> {
    return this.participation.completeProlificParticipation(identity);
  }

  getParticipationOutcome(
    identity: ProlificIdentity,
  ): Promise<ParticipationOutcomeRecord | undefined> {
    return this.participation.getParticipationOutcome(identity);
  }

  listParticipationOutcomes(): Promise<ParticipationOutcomeRecord[]> {
    return this.participation.listParticipationOutcomes();
  }

  getParticipationOutcomeById(
    id: string,
  ): Promise<ParticipationOutcomeRecord | undefined> {
    return this.participation.getParticipationOutcomeById(id);
  }

  markProlificAction(
    arrivalId: string,
    patch: Parameters<ParticipationStore["markProlificAction"]>[1],
  ): Promise<void> {
    return this.participation.markProlificAction(arrivalId, patch);
  }

  dueProlificActions(limit?: number): Promise<ParticipationOutcomeRecord[]> {
    return this.participation.dueProlificActions(limit);
  }

  linkProlificArrival(
    identity: ProlificIdentity,
    participantRecordId: string,
  ): Promise<void> {
    return this.participation.linkProlificArrival(identity, participantRecordId);
  }

  listProlificArrivals(): Promise<ProlificArrival[]> {
    return this.participation.listProlificArrivals();
  }

  // ── rounds, sessions, participants ───────────────────────────────

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
    try {
      const created = await this.db.studyRoundRecord.create({
        data: { id: (maxId._max.id ?? 0) + 1, label: "" },
      });
      return roundFromRow(created);
    } catch (error) {
      // Concurrent first reads can both observe no open round. The database
      // constraints pick a winner; return its round to the other reader.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await this.db.studyRoundRecord.findFirst({ where: { endedAt: null } });
        if (winner) return roundFromRow(winner);
      }
      throw error;
    }
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
        where: { NOT: { conditionId: { startsWith: TEST_CONDITION_PREFIX } } },
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
      (session) => !isTestCondition(session.condition.id),
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
      select: SESSION_SUMMARY_SELECT,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(sessionSummaryFromRow);
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
      data: participantCreateData(sessionId, participant),
    });
  }


  /**
   * Release a seat only while a lobby is still forming. The Prolific arrival
   * remains in its separate audit table; participant/survey data are removed
   * because the person withdrew before a group began.
   */
  async removeParticipantFromWaitingSession(
    sessionId: string,
    participantId: string,
  ): Promise<boolean> {
    if (!this.dbEnabled) {
      const session = this.sessions.get(sessionId);
      if (!session || session.status !== "waiting") return false;
      const index = session.participants.findIndex(
        (participant) => participant.id === participantId,
      );
      if (index < 0) return false;
      session.participants.splice(index, 1);
      this.memoryCreds.delete(participantId);
      if (session.participants.length === 0) session.status = "aborted";
      return true;
    }

    return this.db.$transaction(async (tx) => {
      const session = await tx.sessionRecord.findUnique({
        where: { id: sessionId },
        select: { status: true },
      });
      if (session?.status !== "waiting") return false;
      const removed = await tx.participantRecord.deleteMany({
        where: { id: participantId, sessionId },
      });
      if (removed.count === 0) return false;
      const remaining = await tx.participantRecord.count({ where: { sessionId } });
      if (remaining === 0) {
        await tx.sessionRecord.updateMany({
          where: { id: sessionId, status: "waiting" },
          data: { status: "aborted" },
        });
      }
      return true;
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
    await upsertSurvey(this.db, participantId, kind, survey);
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

    const existing = await this.db.surveyRecord.findFirst({
      where: { participantId, kind: "exit", participant: { sessionId } },
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
      await persistSessionSnapshot(tx, session);
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
      await persistRuntimeCheckpoint(tx, sessionId, checkpoint);
    }, {
      // The default interactive-transaction timeout is five seconds. During a
      // recruitment wave, waiting briefly for a connection is safer than
      // expiring an otherwise healthy monotonic checkpoint transaction.
      maxWait: 10_000,
      timeout: 15_000,
    });
  }

  /** The oldest active, still-forming CURRENT-ROUND session with a free seat. */
  async findForming(conditionId?: string, taskMode?: "ranking" | "etherpad"): Promise<Session | undefined> {
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
      .filter(s => !taskMode || (s.condition.config.workspaceMode === "etherpad" ? "etherpad" : "ranking") === taskMode)
      .filter(
        (s) =>
          s.roundId === current.id &&
          s.participants.length < s.condition.groupSize,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  /**
   * Abort every waiting lobby (a new study round starts). Rows are retained
   * for audit/export; only lifecycle state changes.
   */
  async abortWaitingSessions(): Promise<AbortedLobby[]> {
    return this.abortLobbies(["waiting"]);
  }

  /** Abort every lobby whose durable deadline has passed. */
  async abortExpiredWaitingSessions(now = new Date()): Promise<AbortedLobby[]> {
    return this.abortLobbies(["waiting", "provisioning"], now);
  }

  /**
   * Flip matching lobbies to aborted, each with a conditional update so a
   * group that started (or was aborted) concurrently is left alone. With
   * `deadlinePassedAt`, only lobbies whose waiting deadline has passed match.
   */
  private async abortLobbies(
    statuses: AbortedLobby["priorStatus"][],
    deadlinePassedAt?: Date,
  ): Promise<AbortedLobby[]> {
    if (!this.dbEnabled) {
      const aborted: AbortedLobby[] = [];
      for (const session of this.sessions.values()) {
        const priorStatus = session.status;
        if (
          (priorStatus !== "waiting" && priorStatus !== "provisioning") ||
          !statuses.includes(priorStatus) ||
          (deadlinePassedAt &&
            (!session.waitingDeadlineAt ||
              Date.parse(session.waitingDeadlineAt) > deadlinePassedAt.getTime()))
        ) {
          continue;
        }
        session.status = "aborted";
        aborted.push({
          id: session.id,
          createdAt: session.createdAt,
          participantCount: session.participants.length,
          priorStatus,
        });
      }
      return aborted;
    }

    await this.ensureSeeded();
    const where = {
      status: { in: statuses },
      ...(deadlinePassedAt ? { waitingDeadlineAt: { lte: deadlinePassedAt } } : {}),
    };
    const rows = await this.db.sessionRecord.findMany({
      where,
      select: {
        id: true,
        status: true,
        createdAt: true,
        _count: { select: { participants: true } },
      },
    });
    const aborted: AbortedLobby[] = [];
    for (const row of rows) {
      const changed = await this.db.sessionRecord.updateMany({
        where: { id: row.id, ...where },
        data: { status: "aborted" },
      });
      if (changed.count > 0) {
        aborted.push({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          participantCount: row._count.participants,
          priorStatus: row.status as AbortedLobby["priorStatus"],
        });
      }
    }
    return aborted;
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
    const session = newFormingSession(
      condition,
      (await this.currentRound()).id,
      now,
    );
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
}
