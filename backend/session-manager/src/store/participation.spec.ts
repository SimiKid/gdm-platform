import { describe, expect, it } from "vitest";
import type { ProlificArrival } from "@gdm/shared";
import {
  arrivalKey,
  pendingCompensation,
  terminateMemoryArrival,
  terminatedEvent,
  terminationData,
  type Termination,
} from "./participation";

const identity = { participantId: "pid", studyId: "study", sessionId: "sub" };
const arrivedAt = new Date("2026-09-29T10:00:00.000Z");
const now = new Date("2026-09-29T10:02:30.900Z");
const termination: Termination = {
  outcome: "unmatched",
  reason: "x".repeat(600),
  compensationKind: "partial",
  compensationAmountPence: 30,
};

describe("participation rules", () => {
  it("keys a submission by study and session", () => {
    expect(arrivalKey(identity)).toBe("study:sub");
  });

  it("builds terminal arrival fields with a truncated reason", () => {
    expect(terminationData(now, arrivedAt, termination)).toEqual({
      stage: "terminated",
      stageUpdatedAt: now,
      lastSeenAt: now,
      outcome: "unmatched",
      outcomeReason: "x".repeat(500),
      endedAt: now,
      elapsedSeconds: 150,
      compensationKind: "partial",
      compensationAmountPence: 30,
    });
    // A clock behind the arrival never produces negative elapsed time.
    expect(terminationData(arrivedAt, now, termination).elapsedSeconds).toBe(0);
  });

  it("records the audit event and queues the Prolific action", () => {
    expect(terminatedEvent(termination)).toEqual({
      type: "terminated",
      stage: "terminated",
      detail: { outcome: "unmatched", reason: "x".repeat(500) },
    });
    expect(pendingCompensation(now, termination)).toEqual({
      kind: "partial",
      amountPence: 30,
      status: "pending",
      nextAttemptAt: now,
    });
  });

  it("terminates an in-memory arrival with ISO timestamps", () => {
    const arrival: ProlificArrival = {
      ...identity,
      arrivedAt: arrivedAt.toISOString(),
      stage: "waiting",
      stageUpdatedAt: arrivedAt.toISOString(),
      lastSeenAt: arrivedAt.toISOString(),
    };
    expect(terminateMemoryArrival(identity, arrival, now, termination)).toMatchObject({
      id: "study:sub",
      stage: "terminated",
      outcome: "unmatched",
      endedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      elapsedSeconds: 150,
      prolificActionStatus: "pending",
    });
  });
});
