import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ParticipationOutcomeRecord } from "@gdm/shared";
import { ProlificActionsService } from "./prolific-actions.service";
import { StoreService } from "../store/store.service";

const identity = {
  participantId: "aaaaaaaaaaaaaaaaaaaaaaaa",
  studyId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  sessionId: "cccccccccccccccccccccccc",
};

describe("ProlificActionsService", () => {
  let store: StoreService;
  let service: ProlificActionsService;

  beforeEach(() => {
    process.env.PROLIFIC_API_TOKEN = "test-token";
    store = new StoreService();
    service = new ProlificActionsService(store);
  });

  afterEach(() => {
    delete process.env.PROLIFIC_API_TOKEN;
    vi.unstubAllGlobals();
  });

  async function partialOutcome() {
    return store.terminateProlificParticipation(
      identity,
      "unmatched",
      "group did not form",
      "partial",
      125,
    );
  }

  it("keeps return, bonus preparation, and payment as auditable steps", async () => {
    const outcome = await partialOutcome();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "bonus-batch-1" }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await service.requestReturnById(outcome.id);
    await service.prepareBonusById(outcome.id);
    const paid = await service.payBonusById(outcome.id);

    expect(paid).toMatchObject({
      prolificActionStatus: "payment_submitted",
      bonusBatchId: "bonus-batch-1",
    });
    expect(fetchMock.mock.calls[0][0]).toContain(
      `/submissions/${identity.sessionId}/request-return/`,
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      study_id: identity.studyId,
      csv_bonuses: `${identity.sessionId},1.25`,
    });
  });

  it("never retries an ambiguous non-idempotent payment", async () => {
    const outcome = await partialOutcome();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "bonus-batch-2" }), { status: 201 }),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    await service.prepareBonusById(outcome.id);

    await expect(service.payBonusById(outcome.id)).rejects.toThrow();
    expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
      prolificActionStatus: "payment_uncertain",
      actionError: expect.stringContaining("Verify this bonus"),
    });
    await expect(service.payBonusById(outcome.id)).rejects.toThrow(
      /not in a payable state/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("ProlificActionsService – automation, guards and error handling", () => {
  let store: StoreService;
  let service: ProlificActionsService;
  let counter = 0;

  /** Distinct Prolific identity per outcome so the in-memory store keeps them apart. */
  function nextIdentity() {
    const suffix = String(++counter).padStart(24, "0");
    return {
      participantId: `p${suffix.slice(1)}`,
      studyId: `s${suffix.slice(1)}`,
      sessionId: `r${suffix.slice(1)}`,
    };
  }

  function okJson(body: unknown = {}, status = 200) {
    return new Response(JSON.stringify(body), { status });
  }

  beforeEach(() => {
    process.env.PROLIFIC_API_TOKEN = "test-token";
    delete process.env.PROLIFIC_PAYMENT_AUTOMATION;
    store = new StoreService();
    service = new ProlificActionsService(store);
  });

  afterEach(() => {
    delete process.env.PROLIFIC_API_TOKEN;
    delete process.env.PROLIFIC_PAYMENT_AUTOMATION;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("scheduler", () => {
    it("stays idle unless payment automation is explicitly enabled", () => {
      vi.useFakeTimers();
      const processDue = vi.spyOn(service, "processDue").mockResolvedValue();
      service.onModuleInit();
      vi.advanceTimersByTime(120_000);
      expect(processDue).not.toHaveBeenCalled();
      service.onModuleDestroy(); // no timer to clear — must not throw
    });

    it("polls every 30 seconds when enabled and stops on module destroy", () => {
      vi.useFakeTimers();
      process.env.PROLIFIC_PAYMENT_AUTOMATION = "true";
      const processDue = vi.spyOn(service, "processDue").mockResolvedValue();
      service.onModuleInit();
      vi.advanceTimersByTime(30_000);
      expect(processDue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect(processDue).toHaveBeenCalledTimes(3);
      service.onModuleDestroy();
      vi.advanceTimersByTime(90_000);
      expect(processDue).toHaveBeenCalledTimes(3);
    });
  });

  describe("processDue", () => {
    it("runs return → bonus → payment for a due partial-compensation outcome", async () => {
      const identity = nextIdentity();
      const outcome = await store.terminateProlificParticipation(
        identity,
        "connection_timeout",
        "lost connection",
        "partial",
        250,
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson())
        .mockResolvedValueOnce(okJson({ id: "batch-auto" }, 201))
        .mockResolvedValueOnce(okJson({}, 202));
      vi.stubGlobal("fetch", fetchMock);

      await service.processDue();

      expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
        prolificActionStatus: "payment_submitted",
        bonusBatchId: "batch-auto",
        returnRequestedAt: expect.any(String),
        paymentSubmittedAt: expect.any(String),
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        request_return_reasons: [
          "Connection was lost for longer than the allowed reconnect window.",
        ],
      });
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
        study_id: identity.studyId,
        csv_bonuses: `${identity.sessionId},2.50`,
      });
      // Nothing left to do on the next tick.
      expect(await store.dueProlificActions()).toEqual([]);
    });

    it("only requests a return when no compensation is owed", async () => {
      const identity = nextIdentity();
      const outcome = await store.terminateProlificParticipation(
        identity,
        "declined_consent",
        "",
        "none",
      );
      const fetchMock = vi.fn().mockResolvedValue(okJson());
      vi.stubGlobal("fetch", fetchMock);

      await service.processDue();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        request_return_reasons: ["Withdrew consent."],
      });
      const record = await store.getParticipationOutcomeById(outcome.id);
      expect(record?.prolificActionStatus).toBe("return_requested");
      expect(record?.bonusBatchId).toBeUndefined();
    });

    it("skips the bonus when a partial outcome carries no amount", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        0,
      );
      const fetchMock = vi.fn().mockResolvedValue(okJson());
      vi.stubGlobal("fetch", fetchMock);

      await service.processDue();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
        prolificActionStatus: "return_requested",
      });
    });

    it("records an API failure with a retry backoff and leaves the outcome out of the next batch", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

      await service.processDue();

      const failed = (await store.getParticipationOutcomeById(outcome.id)) as
        | (ParticipationOutcomeRecord & { nextAttemptAt?: string })
        | undefined;
      expect(failed).toMatchObject({
        prolificActionStatus: "failed",
        actionError: "request return failed (500)",
      });
      expect(Date.parse(failed!.nextAttemptAt!)).toBeGreaterThan(Date.now() + 4 * 60_000);
      expect(await store.dueProlificActions()).toEqual([]);
    });

    it("leaves an uncertain payment alone instead of scheduling a retry", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(okJson())
          .mockResolvedValueOnce(okJson({ id: "batch-u" }, 201))
          .mockResolvedValueOnce(new Response("", { status: 502 })),
      );

      await service.processDue();

      expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
        prolificActionStatus: "payment_uncertain",
        actionError: expect.stringContaining("bonus payment returned 502"),
      });
      expect(await store.dueProlificActions()).toEqual([]);
    });

    it("does not start a second pass while one is running", async () => {
      await store.terminateProlificParticipation(nextIdentity(), "unmatched", "", "none");
      const due = vi.spyOn(store, "dueProlificActions");
      let release!: () => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              release = () => resolve(okJson());
            }),
        ),
      );

      const first = service.processDue();
      await Promise.resolve();
      const second = service.processDue();
      await second; // returns immediately
      expect(due).toHaveBeenCalledTimes(1);
      release();
      await first;
      expect(due).toHaveBeenCalledTimes(1);
    });

    it("keeps processing the batch when one outcome fails", async () => {
      const failing = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      const healthy = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response("", { status: 503 }))
          .mockResolvedValueOnce(okJson()),
      );

      await service.processDue();

      expect(await store.getParticipationOutcomeById(failing.id)).toMatchObject({
        prolificActionStatus: "failed",
      });
      expect(await store.getParticipationOutcomeById(healthy.id)).toMatchObject({
        prolificActionStatus: "return_requested",
      });
    });
  });

  describe("manual actions", () => {
    it("rejects actions for unknown outcomes", async () => {
      await expect(service.requestReturnById("missing")).rejects.toThrow(
        /No actionable terminal outcome/,
      );
      await expect(service.resolveManuallyById("missing")).rejects.toThrow(
        /No actionable terminal outcome/,
      );
    });

    it("refuses to talk to Prolific without an API token", async () => {
      delete process.env.PROLIFIC_API_TOKEN;
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(service.requestReturnById(outcome.id)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("replays of already-completed steps are no-ops", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson())
        .mockResolvedValueOnce(okJson({ id: "batch-r" }, 201))
        .mockResolvedValueOnce(okJson({}, 202));
      vi.stubGlobal("fetch", fetchMock);

      await service.requestReturnById(outcome.id);
      await service.requestReturnById(outcome.id);
      await service.prepareBonusById(outcome.id);
      await service.prepareBonusById(outcome.id);
      await service.payBonusById(outcome.id);
      const final = await service.payBonusById(outcome.id);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(final.prolificActionStatus).toBe("payment_submitted");
    });

    it("prepareBonus requests the return first when it has not happened yet", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson())
        .mockResolvedValueOnce(okJson({ id: "batch-p" }, 201));
      vi.stubGlobal("fetch", fetchMock);

      const prepared = await service.prepareBonusById(outcome.id);

      expect(fetchMock.mock.calls[0][0]).toContain("/request-return/");
      expect(fetchMock.mock.calls[1][0]).toContain("/bonus-payments/");
      expect(prepared).toMatchObject({
        prolificActionStatus: "bonus_prepared",
        bonusBatchId: "batch-p",
        returnRequestedAt: expect.any(String),
      });
    });

    it("prepareBonus only applies to partial compensation with a positive amount", async () => {
      const none = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      await expect(service.prepareBonusById(none.id)).rejects.toThrow(
        /Only partial-compensation outcomes/,
      );

      const empty = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        0,
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson()));
      await expect(service.prepareBonusById(empty.id)).rejects.toThrow(
        /partial payment amount is empty/,
      );
    });

    it("prepareBonus fails when Prolific rejects the batch or returns no id", async () => {
      const rejected = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(okJson())
          .mockResolvedValueOnce(new Response("", { status: 400 })),
      );
      await expect(service.prepareBonusById(rejected.id)).rejects.toThrow(
        /bonus preparation failed \(400\)/,
      );

      const noId = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce(okJson()).mockResolvedValueOnce(okJson({}, 201)),
      );
      await expect(service.prepareBonusById(noId.id)).rejects.toThrow(
        /returned no batch id/,
      );
    });

    it("payBonus refuses to pay before a batch was prepared", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(service.payBonusById(outcome.id)).rejects.toThrow(
        /bonus has not been prepared/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("payBonus flags the payment as uncertain when the local paid marker fails after Prolific accepted it", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "partial",
        100,
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson())
        .mockResolvedValueOnce(okJson({ id: "batch-m" }, 201))
        .mockResolvedValueOnce(okJson({}, 202));
      vi.stubGlobal("fetch", fetchMock);
      await service.prepareBonusById(outcome.id);

      const original = store.markProlificAction.bind(store);
      vi.spyOn(store, "markProlificAction").mockImplementation(async (id, patch) => {
        if (patch.status === "payment_submitted") throw new Error("db down");
        return original(id, patch);
      });

      await expect(service.payBonusById(outcome.id)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // The one-way guard persisted before the network call is what remains.
      expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
        prolificActionStatus: "payment_in_progress",
      });
    });

    it("requestReturnAndRecordFailureById persists the failure for admin follow-up", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 429 })));

      await expect(
        service.requestReturnAndRecordFailureById(outcome.id),
      ).rejects.toThrow(/request return failed \(429\)/);
      expect(await store.getParticipationOutcomeById(outcome.id)).toMatchObject({
        prolificActionStatus: "failed",
        actionError: "request return failed (429)",
      });
    });

    it("resolveManuallyById closes the case and clears the error", async () => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        "unmatched",
        "",
        "none",
      );
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
      await service.processDue();

      const resolved = await service.resolveManuallyById(outcome.id);

      expect(resolved).toMatchObject({
        prolificActionStatus: "resolved_manually",
        actionError: undefined,
      });
      expect(await store.dueProlificActions()).toEqual([]);
    });
  });

  describe("return reasons", () => {
    const cases: Array<[Parameters<StoreService["terminateProlificParticipation"]>[1], string, string]> = [
      ["declined_consent", "", "Withdrew consent."],
      ["voluntary_withdrawal", "", "Did not finish study."],
      ["connection_timeout", "", "Connection was lost for longer than the allowed reconnect window."],
      ["unmatched", "", "Could not be matched with the required live group."],
      ["technical_failure", "", "Encountered technical problems."],
      ["group_aborted", "", "Encountered technical problems."],
      ["ineligible", "Failed the English screen", "Failed the English screen"],
      ["participant_dropout", "", "Did not finish study."],
    ];

    it.each(cases)("%s (reason %j) sends %j", async (outcomeKind, reason, expected) => {
      const outcome = await store.terminateProlificParticipation(
        nextIdentity(),
        outcomeKind,
        reason,
        "none",
      );
      const fetchMock = vi.fn().mockResolvedValue(okJson());
      vi.stubGlobal("fetch", fetchMock);

      await service.requestReturnById(outcome.id);

      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        request_return_reasons: [expected],
      });
    });
  });
});
