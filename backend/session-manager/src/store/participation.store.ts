import type {
  ParticipationOutcome,
  ParticipationOutcomeRecord,
  ParticipationStage,
  ProlificArrival,
  ProlificIdentity,
} from "@gdm/shared";
import type { PrismaService } from "../prisma/prisma.service";
import {
  STAGE_ORDER,
  arrivalKey,
  pendingCompensation,
  terminateMemoryArrival,
  terminatedEvent,
  terminationData,
  type TerminationCompensation,
} from "./participation";
import {
  participationOutcomeFromRow,
  prolificArrivalFromRow,
} from "./row-mappers";
import type { StoreBackend } from "./store-backend";

/**
 * Prolific participation outcomes: arrivals, journey stages, terminal
 * outcomes and the queued Prolific actions (return request / payment).
 *
 * Owned by StoreService, which delegates its public participation methods
 * here; like StoreService it persists through Prisma when the database is
 * enabled and otherwise keeps the same behavior in memory.
 */
export class ParticipationStore {
  private readonly prolificArrivals = new Map<string, ProlificArrival>();
  private readonly memoryProlificActions = new Map<
    string,
    Pick<
      ParticipationOutcomeRecord,
      | "returnRequestedAt"
      | "bonusBatchId"
      | "paymentSubmittedAt"
      | "actionError"
    > & { nextAttemptAt?: string }
  >();

  constructor(private readonly backend: StoreBackend) {}

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
        stage: "arrived" as const,
        stageUpdatedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
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
      // A submission's participant identity is immutable. The service checks
      // a mismatching PID and returns a conflict instead of letting a second
      // request overwrite the original linkage.
      update: {},
    });
    return prolificArrivalFromRow(row);
  }

  async getProlificArrival(
    identity: ProlificIdentity,
  ): Promise<ProlificArrival | undefined> {
    const key = arrivalKey(identity);
    if (!this.dbEnabled) return this.prolificArrivals.get(key);
    const row = await this.db.prolificArrivalRecord.findUnique({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
        },
      },
    });
    return row ? prolificArrivalFromRow(row) : undefined;
  }

  /** Active Prolific arrivals whose browser has stopped sending heartbeats. */
  async listStaleProlificArrivals(
    cutoff: Date,
    limit = 100,
  ): Promise<ProlificArrival[]> {
    const activeStages: ParticipationStage[] = [
      "arrived",
      "consent",
      "entry",
      "waiting",
      "chat",
      "exit",
    ];
    if (!this.dbEnabled) {
      return [...this.prolificArrivals.values()]
        .filter(
          (arrival) =>
            !arrival.outcome &&
            activeStages.includes(arrival.stage) &&
            Date.parse(arrival.lastSeenAt) <= cutoff.getTime(),
        )
        .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt))
        .slice(0, limit);
    }
    const rows = await this.db.prolificArrivalRecord.findMany({
      where: {
        outcome: null,
        stage: { in: activeStages },
        lastSeenAt: { lte: cutoff },
      },
      orderBy: { lastSeenAt: "asc" },
      take: limit,
    });
    return rows.map(prolificArrivalFromRow);
  }

  /** Advance a server-validated journey milestone; terminal outcomes are immutable. */
  async recordParticipationStage(
    identity: ProlificIdentity,
    stage: Exclude<ParticipationStage, "done" | "terminated">,
  ): Promise<ProlificArrival> {
    const arrival = await this.recordProlificArrival(identity);
    const now = new Date();
    if (!this.dbEnabled) {
      if (arrival.outcome) return arrival;
      arrival.lastSeenAt = now.toISOString();
      if (
        !arrival.outcome &&
        STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(arrival.stage)
      ) {
        arrival.stage = stage;
        arrival.stageUpdatedAt = now.toISOString();
      }
      return arrival;
    }

    if (arrival.outcome) return arrival;
    const earlierStages = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage));
    const row = await this.db.$transaction(async (tx) => {
      const advanced = await tx.prolificArrivalRecord.updateMany({
        where: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
          outcome: null,
          stage: { in: earlierStages },
        },
        data: { stage, stageUpdatedAt: now, lastSeenAt: now },
      });
      if (advanced.count > 0) {
        const current = await tx.prolificArrivalRecord.findUniqueOrThrow({
          where: {
            prolificStudyId_prolificSessionId: {
              prolificStudyId: identity.studyId,
              prolificSessionId: identity.sessionId,
            },
          },
        });
        await tx.participationEventRecord.create({
          data: {
            prolificArrivalId: current.id,
            type: "stage",
            stage,
          },
        });
        return current;
      }
      // Same/later-stage heartbeat. The outcome predicate ensures a timeout
      // that won the race cannot be overwritten or revived.
      await tx.prolificArrivalRecord.updateMany({
        where: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
          outcome: null,
        },
        data: { lastSeenAt: now },
      });
      return tx.prolificArrivalRecord.findUniqueOrThrow({
        where: {
          prolificStudyId_prolificSessionId: {
            prolificStudyId: identity.studyId,
            prolificSessionId: identity.sessionId,
          },
        },
      });
    });
    return prolificArrivalFromRow(row);
  }

  /** Atomically persist one terminal outcome and its idempotent Prolific action. */
  async terminateProlificParticipation(
    identity: ProlificIdentity,
    outcome: Exclude<ParticipationOutcome, "completed">,
    reason: string,
    compensationKind: TerminationCompensation,
    compensationAmountPence?: number,
  ): Promise<ParticipationOutcomeRecord> {
    const arrival = await this.recordProlificArrival(identity);
    if (arrival.outcome) {
      return this.getParticipationOutcome(identity) as Promise<ParticipationOutcomeRecord>;
    }
    const now = new Date();
    const termination = { outcome, reason, compensationKind, compensationAmountPence };
    if (!this.dbEnabled) {
      return terminateMemoryArrival(identity, arrival, now, termination);
    }

    const result = await this.db.$transaction(async (tx) => {
      const current = await tx.prolificArrivalRecord.findUniqueOrThrow({
        where: {
          prolificStudyId_prolificSessionId: {
            prolificStudyId: identity.studyId,
            prolificSessionId: identity.sessionId,
          },
        },
        include: { compensation: true },
      });
      if (current.outcome) return current;
      return tx.prolificArrivalRecord.update({
        where: { id: current.id },
        data: {
          ...terminationData(now, current.arrivedAt, termination),
          events: { create: terminatedEvent(termination) },
          compensation: {
            upsert: {
              create: pendingCompensation(now, termination),
              update: {},
            },
          },
        },
        include: { compensation: true },
      });
    });
    return participationOutcomeFromRow(result);
  }

  /**
   * Claim a stale heartbeat atomically. A heartbeat that lands after the stale
   * scan but before this write wins, so an active participant is never kicked
   * on an outdated read.
   */
  async terminateStaleProlificParticipation(
    identity: ProlificIdentity,
    cutoff: Date,
    outcome: Exclude<ParticipationOutcome, "completed">,
    reason: string,
    compensationKind: TerminationCompensation,
    compensationAmountPence?: number,
  ): Promise<ParticipationOutcomeRecord | null> {
    const now = new Date();
    const termination = { outcome, reason, compensationKind, compensationAmountPence };
    if (!this.dbEnabled) {
      const arrival = this.prolificArrivals.get(arrivalKey(identity));
      if (
        !arrival ||
        arrival.outcome ||
        Date.parse(arrival.lastSeenAt) > cutoff.getTime()
      ) {
        return null;
      }
      return terminateMemoryArrival(identity, arrival, now, termination);
    }

    const result = await this.db.$transaction(async (tx) => {
      const current = await tx.prolificArrivalRecord.findUnique({
        where: {
          prolificStudyId_prolificSessionId: {
            prolificStudyId: identity.studyId,
            prolificSessionId: identity.sessionId,
          },
        },
      });
      if (current && !current.outcome && current.lastSeenAt <= cutoff) {
        const claimed = await tx.prolificArrivalRecord.updateMany({
          where: {
            id: current.id,
            outcome: null,
            lastSeenAt: { lte: cutoff },
          },
          data: terminationData(now, current.arrivedAt, termination),
        });
        if (claimed.count === 0) return null;
        await tx.participationEventRecord.create({
          data: { prolificArrivalId: current.id, ...terminatedEvent(termination) },
        });
        await tx.prolificCompensationRecord.upsert({
          where: { prolificArrivalId: current.id },
          create: {
            prolificArrivalId: current.id,
            ...pendingCompensation(now, termination),
          },
          update: {},
        });
        return tx.prolificArrivalRecord.findUniqueOrThrow({
          where: { id: current.id },
          include: { compensation: true },
        });
      }
      return null;
    });
    return result ? participationOutcomeFromRow(result) : null;
  }

  async completeProlificParticipation(
    identity: ProlificIdentity,
  ): Promise<ParticipationOutcomeRecord> {
    const arrival = await this.recordProlificArrival(identity);
    const existing = await this.getParticipationOutcome(identity);
    if (existing?.outcome) return existing;
    const now = new Date();
    const elapsedSeconds = Math.max(
      0,
      Math.floor((now.getTime() - Date.parse(arrival.arrivedAt)) / 1_000),
    );
    if (!this.dbEnabled) {
      Object.assign(arrival, {
        stage: "done",
        stageUpdatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        outcome: "completed",
        endedAt: now.toISOString(),
        elapsedSeconds,
        compensationKind: "full",
        prolificActionStatus: "not_required",
      });
      return { id: arrivalKey(identity), ...arrival };
    }
    const row = await this.db.prolificArrivalRecord.update({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
        },
      },
      data: {
        stage: "done",
        stageUpdatedAt: now,
        lastSeenAt: now,
        outcome: "completed",
        endedAt: now,
        elapsedSeconds,
        compensationKind: "full",
        events: { create: { type: "completed", stage: "done" } },
        compensation: {
          upsert: {
            create: { kind: "full", status: "not_required" },
            update: { kind: "full", status: "not_required" },
          },
        },
      },
      include: { compensation: true },
    });
    return participationOutcomeFromRow(row);
  }

  async getParticipationOutcome(
    identity: ProlificIdentity,
  ): Promise<ParticipationOutcomeRecord | undefined> {
    if (!this.dbEnabled) {
      const arrival = this.prolificArrivals.get(arrivalKey(identity));
      if (!arrival) return undefined;
      const id = arrivalKey(identity);
      return { id, ...arrival, ...this.memoryProlificActions.get(id) };
    }
    const row = await this.db.prolificArrivalRecord.findUnique({
      where: {
        prolificStudyId_prolificSessionId: {
          prolificStudyId: identity.studyId,
          prolificSessionId: identity.sessionId,
        },
      },
      include: { compensation: true },
    });
    return row ? participationOutcomeFromRow(row) : undefined;
  }

  async listParticipationOutcomes(): Promise<ParticipationOutcomeRecord[]> {
    if (!this.dbEnabled) {
      return [...this.prolificArrivals.entries()].map(([id, arrival]) => ({
        id,
        ...arrival,
        ...this.memoryProlificActions.get(id),
      }));
    }
    const rows = await this.db.prolificArrivalRecord.findMany({
      include: { compensation: true },
      orderBy: { arrivedAt: "desc" },
    });
    return rows.map(participationOutcomeFromRow);
  }

  async getParticipationOutcomeById(
    id: string,
  ): Promise<ParticipationOutcomeRecord | undefined> {
    if (!this.dbEnabled) {
      return this.listParticipationOutcomes().then((rows) =>
        rows.find((row) => row.id === id),
      );
    }
    const row = await this.db.prolificArrivalRecord.findUnique({
      where: { id },
      include: { compensation: true },
    });
    return row ? participationOutcomeFromRow(row) : undefined;
  }

  async markProlificAction(
    arrivalId: string,
    patch: {
      status: string;
      returnRequestedAt?: Date;
      bonusBatchId?: string;
      paymentSubmittedAt?: Date;
      actionError?: string | null;
      nextAttemptAt?: Date | null;
    },
  ): Promise<void> {
    if (!this.dbEnabled) {
      const outcome = await this.getParticipationOutcomeById(arrivalId);
      if (!outcome) return;
      const current = this.memoryProlificActions.get(arrivalId) ?? {};
      this.memoryProlificActions.set(arrivalId, {
        ...current,
        ...(patch.returnRequestedAt
          ? { returnRequestedAt: patch.returnRequestedAt.toISOString() }
          : {}),
        ...(patch.bonusBatchId ? { bonusBatchId: patch.bonusBatchId } : {}),
        ...(patch.paymentSubmittedAt
          ? { paymentSubmittedAt: patch.paymentSubmittedAt.toISOString() }
          : {}),
        ...(patch.actionError !== undefined
          ? { actionError: patch.actionError ?? undefined }
          : {}),
        ...(patch.nextAttemptAt !== undefined
          ? { nextAttemptAt: patch.nextAttemptAt?.toISOString() }
          : {}),
      });
      const arrival = this.prolificArrivals.get(
        arrivalKey({
          participantId: outcome.participantId,
          studyId: outcome.studyId,
          sessionId: outcome.sessionId,
        }),
      );
      if (arrival) {
        arrival.prolificActionStatus =
          patch.status as ProlificArrival["prolificActionStatus"];
      }
      return;
    }
    await this.db.prolificCompensationRecord.update({
      where: { prolificArrivalId: arrivalId },
      data: { ...patch, attemptCount: { increment: 1 } },
    });
  }

  async dueProlificActions(limit = 20): Promise<ParticipationOutcomeRecord[]> {
    if (!this.dbEnabled) {
      const now = Date.now();
      return (await this.listParticipationOutcomes())
        .filter((outcome) => {
          if (!outcome.outcome) return false;
          if (
            !["pending", "failed"].includes(
              outcome.prolificActionStatus ?? "",
            )
          ) {
            return false;
          }
          const next = this.memoryProlificActions.get(outcome.id)?.nextAttemptAt;
          return !next || Date.parse(next) <= now;
        })
        .slice(0, limit);
    }
    const rows = await this.db.prolificArrivalRecord.findMany({
      where: {
        compensation: {
          status: { in: ["pending", "failed"] },
          attemptCount: { lt: 5 },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
      },
      include: { compensation: true },
      orderBy: { endedAt: "asc" },
      take: limit,
    });
    return rows.map(participationOutcomeFromRow);
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

  private get dbEnabled(): boolean {
    return this.backend.dbEnabled();
  }

  private get db(): PrismaService {
    return this.backend.db();
  }

  private ensureSeeded(): Promise<void> {
    return this.backend.ensureSeeded();
  }
}
