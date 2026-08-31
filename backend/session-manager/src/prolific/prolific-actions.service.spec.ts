import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
