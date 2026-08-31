import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ParticipationOutcomeRecord } from "@gdm/shared";
import { StoreService } from "../store/store.service";

/**
 * Server-only, auditable Prolific writes. Automatic processing is opt-in and
 * defaults off; local tests mock the API and never move money.
 */
@Injectable()
export class ProlificActionsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ProlificActionsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly store: StoreService) {}

  onModuleInit(): void {
    if (process.env.PROLIFIC_PAYMENT_AUTOMATION !== "true") return;
    this.timer = setInterval(() => void this.processDue(), 30_000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const outcome of await this.store.dueProlificActions()) {
        try {
          await this.processAll(outcome);
        } catch (error) {
          if (!(error instanceof PaymentUncertainError)) {
            await this.recordFailure(outcome.id, error);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  async requestReturnById(id: string): Promise<ParticipationOutcomeRecord> {
    const outcome = await this.requireOutcome(id);
    if (outcome.returnRequestedAt) return outcome;
    await this.requestReturn(outcome);
    return (await this.store.getParticipationOutcomeById(id))!;
  }

  /** Automatic disconnect handling records API failures for admin follow-up. */
  async requestReturnAndRecordFailureById(
    id: string,
  ): Promise<ParticipationOutcomeRecord> {
    try {
      return await this.requestReturnById(id);
    } catch (error) {
      await this.recordFailure(id, error);
      throw error;
    }
  }

  async prepareBonusById(id: string): Promise<ParticipationOutcomeRecord> {
    const outcome = await this.requireOutcome(id);
    if (outcome.compensationKind !== "partial") {
      throw new Error("Only partial-compensation outcomes can prepare a bonus");
    }
    if (outcome.bonusBatchId) return outcome;
    if (!outcome.returnRequestedAt) {
      await this.requestReturn(outcome);
    }
    await this.prepareBonus((await this.store.getParticipationOutcomeById(id))!);
    return (await this.store.getParticipationOutcomeById(id))!;
  }

  async payBonusById(id: string): Promise<ParticipationOutcomeRecord> {
    const outcome = await this.requireOutcome(id);
    if (outcome.paymentSubmittedAt) return outcome;
    await this.payBonus(outcome);
    return (await this.store.getParticipationOutcomeById(id))!;
  }

  async resolveManuallyById(id: string): Promise<ParticipationOutcomeRecord> {
    await this.requireOutcome(id);
    await this.store.markProlificAction(id, {
      status: "resolved_manually",
      actionError: null,
      nextAttemptAt: null,
    });
    return (await this.store.getParticipationOutcomeById(id))!;
  }

  private async processAll(outcome: ParticipationOutcomeRecord): Promise<void> {
    if (!outcome.outcome || outcome.outcome === "completed") return;
    let current = outcome;
    if (
      !current.returnRequestedAt &&
      current.prolificActionStatus !== "return_requested"
    ) {
      await this.requestReturn(current);
      current = (await this.store.getParticipationOutcomeById(outcome.id))!;
    }
    if (
      current.compensationKind === "partial" &&
      (current.compensationAmountPence ?? 0) > 0
    ) {
      if (!current.bonusBatchId) {
        await this.prepareBonus(current);
        current = (await this.store.getParticipationOutcomeById(outcome.id))!;
      }
      if (!current.paymentSubmittedAt) await this.payBonus(current);
    }
  }

  private async requestReturn(outcome: ParticipationOutcomeRecord): Promise<void> {
    const response = await this.prolificFetch(
      `/submissions/${outcome.sessionId}/request-return/`,
      {
        method: "POST",
        body: JSON.stringify({
          request_return_reasons: [returnReason(outcome)],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`request return failed (${response.status})`);
    }
    await this.store.markProlificAction(outcome.id, {
      status: "return_requested",
      returnRequestedAt: new Date(),
      actionError: null,
      nextAttemptAt: null,
    });
  }

  private async prepareBonus(outcome: ParticipationOutcomeRecord): Promise<void> {
    const amountPence = outcome.compensationAmountPence ?? 0;
    if (amountPence <= 0) throw new Error("partial payment amount is empty");
    const response = await this.prolificFetch("/submissions/bonus-payments/", {
      method: "POST",
      body: JSON.stringify({
        study_id: outcome.studyId,
        csv_bonuses: `${outcome.sessionId},${(amountPence / 100).toFixed(2)}`,
      }),
    });
    if (!response.ok) throw new Error(`bonus preparation failed (${response.status})`);
    const body = (await response.json()) as { id?: string };
    if (!body.id) throw new Error("bonus preparation returned no batch id");
    await this.store.markProlificAction(outcome.id, {
      status: "bonus_prepared",
      bonusBatchId: body.id,
      actionError: null,
      nextAttemptAt: null,
    });
  }

  private async payBonus(outcome: ParticipationOutcomeRecord): Promise<void> {
    if (!outcome.bonusBatchId) throw new Error("bonus has not been prepared");
    if (outcome.prolificActionStatus !== "bonus_prepared") {
      throw new Error("bonus is not in a payable state");
    }
    if (!process.env.PROLIFIC_API_TOKEN?.trim()) {
      throw new ServiceUnavailableException("PROLIFIC_API_TOKEN is not configured");
    }

    // Prolific explicitly documents this endpoint as non-idempotent: sending
    // the same batch twice pays twice. Persist a one-way guard before the
    // network call. A crash or ambiguous response requires human reconciliation
    // in Prolific; the worker must never guess and retry.
    await this.store.markProlificAction(outcome.id, {
      status: "payment_in_progress",
      actionError: null,
      nextAttemptAt: null,
    });

    let response: Response;
    try {
      response = await this.prolificFetch(
        `/bulk-bonus-payments/${outcome.bonusBatchId}/pay/`,
        { method: "POST", body: "{}" },
      );
    } catch (error) {
      await this.markPaymentUncertain(outcome.id, error);
      throw new PaymentUncertainError();
    }
    if (!response.ok) {
      await this.markPaymentUncertain(
        outcome.id,
        new Error(`bonus payment returned ${response.status}`),
      );
      throw new PaymentUncertainError();
    }
    try {
      await this.store.markProlificAction(outcome.id, {
        status: "payment_submitted",
        paymentSubmittedAt: new Date(),
        actionError: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      this.log.error(
        `Prolific accepted bonus ${outcome.bonusBatchId}, but the local paid marker failed: ${String(error)}`,
      );
      throw new PaymentUncertainError();
    }
  }

  private async markPaymentUncertain(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.store.markProlificAction(id, {
      status: "payment_uncertain",
      actionError:
        `Verify this bonus in Prolific before taking another action: ${message}`.slice(
          0,
          500,
        ),
      nextAttemptAt: null,
    });
  }

  private async prolificFetch(path: string, init: RequestInit): Promise<Response> {
    const token = process.env.PROLIFIC_API_TOKEN?.trim();
    if (!token) {
      throw new ServiceUnavailableException("PROLIFIC_API_TOKEN is not configured");
    }
    return fetch(`https://api.prolific.com/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: init.signal ?? AbortSignal.timeout(8_000),
    });
  }

  private async requireOutcome(id: string): Promise<ParticipationOutcomeRecord> {
    const outcome = await this.store.getParticipationOutcomeById(id);
    if (!outcome?.outcome || outcome.outcome === "completed") {
      throw new Error("No actionable terminal outcome");
    }
    return outcome;
  }

  private async recordFailure(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error(`Prolific action ${id} failed: ${message}`);
    await this.store.markProlificAction(id, {
      status: "failed",
      actionError: message.slice(0, 500),
      nextAttemptAt: new Date(Date.now() + 5 * 60_000),
    });
  }
}

class PaymentUncertainError extends Error {}

function returnReason(outcome: ParticipationOutcomeRecord): string {
  switch (outcome.outcome) {
    case "declined_consent":
      return "Withdrew consent.";
    case "voluntary_withdrawal":
      return "Did not finish study.";
    case "connection_timeout":
      return "Connection was lost for longer than the allowed reconnect window.";
    case "unmatched":
      return "Could not be matched with the required live group.";
    case "technical_failure":
    case "group_aborted":
      return "Encountered technical problems.";
    default:
      return outcome.outcomeReason || "Did not finish study.";
  }
}
