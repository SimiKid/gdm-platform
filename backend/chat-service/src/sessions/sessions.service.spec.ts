import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionsService } from "./sessions.service";
import type {
  MatrixBotService,
  TimelineEvent,
} from "../matrix/matrix-bot.service";
import type { BotRules } from "../rules/bot-rules";
import { DEFAULT_INTERVENTION_CONFIG } from "@gdm/shared";
import type { Condition, StartSessionNotification } from "@gdm/shared";

const condition: Condition = {
  id: "c",
  name: "C",
  active: true,
  goal: 5,
  durationMinutes: 10,
  groupSize: 3,
  config: { ...DEFAULT_INTERVENTION_CONFIG },
};

const note: StartSessionNotification = {
  sessionId: "s",
  roomId: "!r",
  condition,
  durationMinutes: 10,
};

function makeBot() {
  const handlers: ((e: TimelineEvent) => void)[] = [];
  const bot = {
    botUserId: "@bot:localhost",
    onTimelineEvent: (h: (e: TimelineEvent) => void) => handlers.push(h),
    join: vi.fn(async () => undefined),
    joinAs: vi.fn(async () => undefined),
    start: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    sendText: vi.fn(async () => undefined),
    sendTextAs: vi.fn(async () => undefined),
    getJoinedMemberIds: vi.fn(async () => ["@u:localhost", "@u2:localhost"]),
  };
  return { bot: bot as unknown as MatrixBotService, emit: (e: TimelineEvent) => handlers.forEach((h) => h(e)) };
}

describe("SessionsService (chat-service)", () => {
  let emit: (e: TimelineEvent) => void;
  let bot: MatrixBotService;
  let rules: { onEvent: ReturnType<typeof vi.fn> };
  let svc: SessionsService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ bot, emit } = makeBot());
    rules = { onEvent: vi.fn() };
    svc = new SessionsService(bot, rules as unknown as BotRules);
    fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("startSession joins the room", async () => {
    await svc.startSession(note);
    expect(bot.join).toHaveBeenCalledWith("!r");
    expect(bot.joinAs).not.toHaveBeenCalled();
  });

  it("startSession also joins both comparison bots when the condition asks for it", async () => {
    await svc.startSession({
      ...note,
      condition: {
        ...condition,
        config: { ...condition.config, comparisonMode: true },
      },
    });
    expect(bot.join).toHaveBeenCalledWith("!r");
    expect(bot.joinAs).toHaveBeenCalledWith("a", "!r");
    expect(bot.joinAs).toHaveBeenCalledWith("b", "!r");
  });

  it("does not start the same room twice", async () => {
    await svc.startSession(note);
    await svc.startSession(note);
    expect(bot.join).toHaveBeenCalledTimes(1);
  });

  it("a failed join does not orphan the session — the next start retries", async () => {
    (bot.join as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("synapse hiccup"));
    await expect(svc.startSession(note)).rejects.toThrow("synapse hiccup");

    // The dedupe guard must not have swallowed the room: a retry joins.
    await svc.startSession(note);
    expect(bot.join).toHaveBeenCalledTimes(2);

    // And the retried session runs normally (timer finalizes it).
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/finalize"),
      expect.any(Object),
    );
  });

  it("collects messages, reactions and ranking; runs rules; ignores its own events", async () => {
    await svc.startSession(note);
    emit({ roomId: "!r", type: "m.room.message", sender: "@u:localhost", eventId: "m1", ts: 1000, content: { body: "hi" } });
    emit({ roomId: "!r", type: "m.reaction", sender: "@u2:localhost", eventId: "re1", ts: 1001, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "m1", key: "👍" } } });
    emit({ roomId: "!r", type: "de.gdm.ranking", sender: "@u:localhost", eventId: "rk1", ts: 1002, content: { taskId: "t", order: ["a", "b"], updatedAt: "", updatedBy: "u", movement: { itemId: "a", from: 1, to: 0 } } });
    emit({ roomId: "!r", type: "de.gdm.behavior", sender: "@u:localhost", eventId: "ty1", ts: 1003, content: { type: "typing-stop", durationMs: 800 } });
    emit({ roomId: "!r", type: "m.room.redaction", sender: "@u2:localhost", eventId: "rd1", ts: 1004, content: {}, redacts: "re1" });
    emit({ roomId: "!r", type: "m.room.message", sender: "@bot:localhost", eventId: "b1", ts: 1004, content: { body: "own" } });

    // rules run (serialized per room) for every non-own event.
    await vi.advanceTimersByTimeAsync(0);
    expect(rules.onEvent).toHaveBeenCalledTimes(5);

    await svc.endSession("!r");
    const lastCall = fetchMock.mock.calls.at(-1) as [string, { body: string }];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.messages).toHaveLength(1);
    expect(lastBody.messages[0].reactions).toHaveLength(0); // added then redacted
    expect(lastBody.rankingHistory).toHaveLength(1);
    expect(lastBody.behavioralEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ranking-move" }),
        expect.objectContaining({ type: "typing-stop", durationMs: 800 }),
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/finalize"),
      expect.any(Object),
    );
  });

  it("ignores events for rooms it isn't managing", async () => {
    await svc.startSession(note);
    emit({ roomId: "!other", type: "m.room.message", sender: "@u:localhost", eventId: "x", ts: 1, content: { body: "hi" } });
    expect(rules.onEvent).not.toHaveBeenCalled();
  });

  it("finalizes automatically when the discussion timer ends", async () => {
    await svc.startSession(note);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/finalize"),
      expect.any(Object),
    );
  });

  it("endSession is idempotent", async () => {
    await svc.startSession(note);
    await svc.endSession("!r");
    fetchMock.mockClear();
    await svc.endSession("!r");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
