import { describe, expect, it } from "vitest";
import type { Participant } from "@gdm/shared";
import { seedConditions } from "./conditions";
import { newFormingSession } from "./forming-session";
import {
  conditionData,
  conditionFromRow,
  participantCreateData,
  participantUpdateData,
  participationOutcomeFromRow,
  prolificArrivalFromRow,
  roundFromRow,
  sessionCreateData,
  sessionFromRow,
  sessionSummary,
  sessionSummaryFromRow,
  sessionUpdateData,
  type SessionRow,
} from "./row-mappers";

const T0 = new Date("2026-09-29T10:00:00.000Z");
const T1 = new Date("2026-09-29T10:05:00.000Z");

const participant: Participant = {
  id: "p1",
  name: "Alex",
  trackingToken: "token",
  recruitmentSource: "prolific",
  prolific: { participantId: "pid", studyId: "study", sessionId: "sub" },
};

function arrivalRow() {
  return {
    prolificPid: "pid",
    prolificStudyId: "study",
    prolificSessionId: "sub",
    participantRecordId: null,
    arrivedAt: T0,
    stage: "chat",
    stageUpdatedAt: T0,
    lastSeenAt: T1,
    outcome: null,
    outcomeReason: null,
    endedAt: null,
    elapsedSeconds: null,
    compensationKind: null,
    compensationAmountPence: null,
  };
}

describe("row mappers", () => {
  it("normalizes a condition read back from its row", () => {
    const [condition] = seedConditions();
    const row = { ...conditionData(condition), goal: Number.NaN };
    expect(conditionFromRow(row as Parameters<typeof conditionFromRow>[0])).toMatchObject({
      id: condition.id,
      goal: 0,
      config: { interventionMode: "baseline" },
    });
  });

  it("writes new sessions in full and never clears a stored completion time", () => {
    const session = newFormingSession(seedConditions()[1], 2, T0.toISOString());
    expect(sessionCreateData(session)).toMatchObject({
      id: session.id,
      roundId: 2,
      checkpointRevision: 0,
      classificationFailures: [],
      createdAt: T0,
      startedAt: undefined,
    });
    expect(sessionUpdateData(session)).not.toHaveProperty("completedAt");
    expect(
      sessionUpdateData({ ...session, completedAt: T1.toISOString() }),
    ).toMatchObject({ completedAt: T1 });
  });

  it("maps participant writes without clearing completion on update", () => {
    expect(participantCreateData("s1", participant)).toMatchObject({
      id: "p1",
      sessionId: "s1",
      prolificPid: "pid",
      completedAt: undefined,
    });
    expect(participantUpdateData("s1", participant)).not.toHaveProperty("completedAt");
    expect(
      participantUpdateData("s1", { ...participant, completedAt: T1.toISOString() }),
    ).toMatchObject({ completedAt: T1 });
  });

  it("hydrates a session row with participants, reactions and history", () => {
    const base = newFormingSession(seedConditions()[1], 1, T0.toISOString());
    const evaluation = { id: "w1", windowEnd: T1.toISOString(), outcome: "nudged" };
    const row = {
      ...sessionCreateData(base),
      id: base.id,
      status: "running",
      createdAt: T0,
      startedAt: T0,
      completedAt: null,
      waitingDeadlineAt: null,
      roomId: null,
      checkpointRevision: 3,
      participants: [
        {
          id: "p1",
          name: "Alex",
          trackingToken: "token",
          recruitmentSource: "prolific",
          prolificPid: "pid",
          prolificStudyId: "study",
          prolificSessionId: "sub",
          completedAt: T1,
          matrixUserId: "@p1:x",
          surveys: [
            { kind: "entry", answers: { age: 30 }, submittedAt: T0 },
            { kind: "exit", answers: { fairness: 5 }, submittedAt: T1 },
          ],
        },
        {
          id: "p2",
          name: "Sam",
          trackingToken: "token2",
          recruitmentSource: "direct",
          prolificPid: null,
          prolificStudyId: null,
          prolificSessionId: null,
          completedAt: null,
          matrixUserId: null,
          surveys: [],
        },
      ],
      messages: [
        {
          id: "m1",
          timestamp: T0,
          senderId: "@p1:x",
          recipientId: null,
          text: "hi",
          reactions: [
            { eventId: "$a", key: "👍", senderId: "@p2:x", timestamp: T0, redacted: false, redactionEventId: null, redactedAt: null },
            { eventId: "$b", key: "❤️", senderId: "@p2:x", timestamp: T0, redacted: true, redactionEventId: "$x", redactedAt: T1 },
            { eventId: null, key: "👀", senderId: "@p2:x", timestamp: T0, redacted: false, redactionEventId: null, redactedAt: null },
          ],
        },
      ],
      rankingHistory: [{ ranking: base.ranking }],
      interventions: [{ payload: { id: "i1" } }],
      windowEvaluations: [{ payload: evaluation }],
    } as unknown as SessionRow;

    const session = sessionFromRow(row);

    expect(session).toMatchObject({
      status: "running",
      checkpointRevision: 3,
      startedAt: T0.toISOString(),
      completedAt: undefined,
      roomId: undefined,
      rankingHistory: [base.ranking],
      interventions: [{ id: "i1" }],
      windowEvaluations: [evaluation],
      redactedReactionEventIds: ["$b"],
    });
    expect(session.participants[0]).toMatchObject({
      prolific: { participantId: "pid", studyId: "study", sessionId: "sub" },
      completedAt: T1.toISOString(),
      matrixUserId: "@p1:x",
      entrySurvey: { answers: { age: 30 }, submittedAt: T0.toISOString() },
      exitSurvey: { answers: { fairness: 5 }, submittedAt: T1.toISOString() },
    });
    expect(session.participants[1]).toMatchObject({
      prolific: undefined,
      matrixUserId: undefined,
      entrySurvey: undefined,
      exitSurvey: undefined,
    });
    expect(session.chat.messages[0].reactions).toEqual([
      { eventId: "$a", key: "👍", senderId: "@p2:x", timestamp: T0.toISOString() },
      { key: "👀", senderId: "@p2:x", timestamp: T0.toISOString() },
    ]);
    expect(session.reactionEvents).toEqual([
      expect.objectContaining({ eventId: "$a", messageId: "m1", redacted: false, redactionEventId: undefined }),
      expect.objectContaining({ eventId: "$b", redacted: true, redactionEventId: "$x", redactedAt: T1.toISOString() }),
    ]);
    expect(sessionSummary(session)).toMatchObject({
      participantCount: 2,
      messageCount: 1,
      interventionCount: 1,
      rankingEditCount: 1,
    });
  });

  it("summarizes a session row from its counts", () => {
    const [condition] = seedConditions();
    expect(
      sessionSummaryFromRow({
        id: "s1",
        status: "waiting",
        roundId: 1,
        conditionId: condition.id,
        conditionSnapshot: condition as never,
        createdAt: T0,
        startedAt: null,
        completedAt: T1,
        waitingDeadlineAt: T1,
        roomId: null,
        _count: { participants: 2, messages: 3, interventions: 1, rankingHistory: 0 },
      }),
    ).toEqual({
      id: "s1",
      status: "waiting",
      roundId: 1,
      conditionId: condition.id,
      conditionName: condition.name,
      participantCount: 2,
      groupSize: condition.groupSize,
      messageCount: 3,
      interventionCount: 1,
      rankingEditCount: 0,
      createdAt: T0.toISOString(),
      startedAt: undefined,
      completedAt: T1.toISOString(),
      waitingDeadlineAt: T1.toISOString(),
      roomId: undefined,
    });
  });

  it("maps Prolific arrivals and their compensation state", () => {
    expect(prolificArrivalFromRow(arrivalRow())).toEqual({
      participantId: "pid",
      studyId: "study",
      sessionId: "sub",
      participantRecordId: undefined,
      arrivedAt: T0.toISOString(),
      stage: "chat",
      stageUpdatedAt: T0.toISOString(),
      lastSeenAt: T1.toISOString(),
      outcome: undefined,
      outcomeReason: undefined,
      endedAt: undefined,
      elapsedSeconds: undefined,
      compensationKind: undefined,
      compensationAmountPence: undefined,
    });
    expect(participationOutcomeFromRow({ ...arrivalRow(), id: "a1", compensation: null }))
      .toMatchObject({ id: "a1", prolificActionStatus: undefined, bonusBatchId: undefined });
    expect(
      participationOutcomeFromRow({
        ...arrivalRow(),
        id: "a1",
        outcome: "unmatched",
        compensationKind: "partial",
        compensationAmountPence: 50,
        compensation: {
          status: "submitted",
          returnRequestedAt: T0,
          bonusBatchId: "b1",
          paymentSubmittedAt: T1,
          actionError: null,
        },
      }),
    ).toMatchObject({
      outcome: "unmatched",
      compensationKind: "partial",
      compensationAmountPence: 50,
      prolificActionStatus: "submitted",
      returnRequestedAt: T0.toISOString(),
      bonusBatchId: "b1",
      paymentSubmittedAt: T1.toISOString(),
      actionError: undefined,
    });
  });

  it("maps study rounds", () => {
    expect(roundFromRow({ id: 1, label: "Pilot", startedAt: T0, endedAt: null })).toEqual({
      id: 1,
      label: "Pilot",
      startedAt: T0.toISOString(),
      endedAt: undefined,
    });
    expect(roundFromRow({ id: 2, label: "", startedAt: T0, endedAt: T1 }).endedAt).toBe(
      T1.toISOString(),
    );
  });
});
