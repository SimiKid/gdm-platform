import { describe, expect, it } from "vitest";
import type {
  BehavioralEvent,
  CheckpointSessionRequest,
  Message,
  Ranking,
  Session,
} from "@gdm/shared";
import {
  acceptsCheckpointState,
  checkpointFromSession,
  mergeCheckpointIntoSession,
  newestRanking,
  rankingKey,
  reactionKey,
} from "./checkpoint-merge";
import { seedConditions } from "./conditions";
import { newFormingSession } from "./forming-session";

const T0 = "2026-09-29T10:00:00.000Z";

function session(workspaceMode?: "etherpad"): Session {
  const [condition] = seedConditions();
  return newFormingSession(
    workspaceMode
      ? { ...condition, config: { ...condition.config, workspaceMode } }
      : condition,
    1,
    T0,
  );
}

function ranking(updatedAt: string, order: string[], eventId?: string): Ranking {
  return { taskId: "moon", order, updatedAt, updatedBy: "@a:x", ...(eventId ? { eventId } : {}) };
}

function message(id: string, reactions: Message["reactions"] = []): Message {
  return { id, timestamp: T0, senderId: "@a:x", text: id, reactions };
}

/** A checkpoint carrying only the given fields (plus the required empty lists). */
function cp(fields: Partial<CheckpointSessionRequest>): CheckpointSessionRequest {
  return { messages: [], rankingHistory: [], ...fields };
}

function event(id: string, type: BehavioralEvent["type"], durationMs?: number): BehavioralEvent {
  return { id, type, participantId: "@a:x", timestamp: T0, durationMs };
}

describe("checkpoint merge", () => {
  it("round-trips a session's runtime state as a checkpoint", () => {
    const s = session();
    const checkpoint = checkpointFromSession(s);
    expect(checkpoint).toMatchObject({
      messages: [],
      rankingHistory: [],
      reactionEvents: [],
      ruleState: {},
    });
    expect(checkpointFromSession({ ...s, rankingHistory: undefined, runtimeState: undefined }))
      .toMatchObject({ rankingHistory: [], ruleState: {} });
  });

  it("accepts mutable state from unversioned or not-older checkpoints only", () => {
    expect(acceptsCheckpointState(undefined, 5)).toBe(true);
    expect(acceptsCheckpointState(5, 5)).toBe(true);
    expect(acceptsCheckpointState(4, 5)).toBe(false);
  });

  it("keys rankings by event id, else by their full content", () => {
    expect(rankingKey(ranking(T0, ["a"], "$e"))).toBe("event:$e");
    const moved = { ...ranking(T0, ["a", "b"]), movement: { itemId: "a", from: 1, to: 0 } };
    expect(rankingKey(moved)).toContain("a:1:0");
    expect(rankingKey(ranking(T0, ["a", "b"]))).not.toBe(rankingKey(ranking(T0, ["b", "a"])));
    expect(reactionKey("m", "👍", "@a:x")).toBe("m\u0000👍\u0000@a:x");
  });

  it("picks the newest parsable ranking", () => {
    const old = ranking("2026-09-29T10:00:00.000Z", ["a"]);
    const newer = ranking("2026-09-29T10:05:00.000Z", ["b"]);
    const broken = ranking("not a date", ["c"]);
    expect(newestRanking(old, newer, broken)).toBe(newer);
    expect(newestRanking(newer, old)).toBe(newer);
    expect(newestRanking(broken, old)).toBe(old);
  });

  it("appends messages and reactions without duplicates", () => {
    const s = session();
    const first = message("m1", [{ key: "👍", senderId: "@b:x", timestamp: T0 }]);
    mergeCheckpointIntoSession(s, cp({ messages: [first] }));
    mergeCheckpointIntoSession(s, cp({
      messages: [
        message("m1", [
          { key: "👍", senderId: "@b:x", timestamp: T0 },
          { eventId: "$r2", key: "❤️", senderId: "@b:x", timestamp: T0 },
        ]),
        message("m2"),
      ],
    }));

    expect(s.chat.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.chat.messages[0].reactions.map((r) => r.key)).toEqual(["👍", "❤️"]);
  });

  it("keeps redactions monotonic across late snapshots", () => {
    const s = session();
    const active = { eventId: "$r", key: "👍", senderId: "@b:x", timestamp: T0 };
    mergeCheckpointIntoSession(s, cp({
      messages: [message("m1", [active])],
      reactionEvents: [{ ...active, messageId: "m1", redacted: false }],
    }));
    mergeCheckpointIntoSession(s, cp({
      reactionEvents: [
        { ...active, messageId: "m1", redacted: true, redactionEventId: "$x", redactedAt: T0 },
      ],
    }));
    // A late snapshot still carrying the active reaction cannot revive it.
    mergeCheckpointIntoSession(s, cp({
      messages: [message("m1", [active]), message("m2", [active])],
      reactionEvents: [{ ...active, messageId: "m1", redacted: false }],
    }));

    expect(s.redactedReactionEventIds).toEqual(["$r"]);
    expect(s.reactionEvents).toEqual([
      expect.objectContaining({ eventId: "$r", redacted: true, redactionEventId: "$x", redactedAt: T0 }),
    ]);
    expect(s.chat.messages.map((m) => m.reactions)).toEqual([[], []]);
  });

  it("replaces mutable state only from a checkpoint that is not older", () => {
    const s = session();
    const newer = cp({
      revision: 2,
      behavioralEvents: [event("e1", "typing-stop", 100)],
      ruleState: { windows: 2 },
      processedEventIds: ["$1"],
    });
    mergeCheckpointIntoSession(s, newer);
    mergeCheckpointIntoSession(s, cp({
      revision: 1,
      behavioralEvents: [event("e1", "typing-stop", 999), event("e2", "tab-hidden")],
      ruleState: { windows: 1 },
      processedEventIds: ["$1", "$2"],
    }));

    expect(s.checkpointRevision).toBe(2);
    expect(s.runtimeState).toEqual({ windows: 2 });
    expect(s.behavioralEvents.map((e) => [e.id, e.durationMs])).toEqual([
      ["e1", 100],
      ["e2", undefined],
    ]);
    expect(s.processedEventIds).toEqual(["$1", "$2"]);
  });

  it("follows the newest ranking of an unversioned checkpoint once history exists", () => {
    const s = session();
    const first = ranking("2026-09-29T10:05:00.000Z", ["a", "b"]);
    const stale = ranking("2026-09-29T10:01:00.000Z", ["b", "a"]);
    mergeCheckpointIntoSession(s, cp({ rankingHistory: [first] }));
    expect(s.ranking).toBe(first);

    mergeCheckpointIntoSession(s, cp({ rankingHistory: [stale] }));
    expect(s.ranking).toBe(first);
    expect(s.rankingHistory).toEqual([first, stale]);

    mergeCheckpointIntoSession(s, cp({ revision: 1, rankingHistory: [stale] }));
    expect(s.ranking).toBe(stale);
  });

  it("drops ranking state from an Etherpad session's checkpoint", () => {
    const s = session("etherpad");
    mergeCheckpointIntoSession(s, cp({
      rankingHistory: [ranking(T0, ["a"])],
      behavioralEvents: [event("e1", "ranking-move"), event("e2", "tab-hidden")],
    }));

    expect(s.rankingHistory).toEqual([]);
    expect(s.ranking.order).toEqual([]);
    expect(s.behavioralEvents.map((e) => e.id)).toEqual(["e2"]);
  });
});
