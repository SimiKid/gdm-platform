import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SessionsService } from "./sessions.service";
import type {
  MatrixBotService,
  TimelineEvent,
} from "../matrix/matrix-bot.service";
import type { BotRules } from "../rules/bot-rules";
import { DEFAULT_INTERVENTION_CONFIG } from "@gdm/shared";
import type {
  Condition,
  RuntimeCheckpoint,
  StartSessionNotification,
} from "@gdm/shared";

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

function emptyCheckpoint(): RuntimeCheckpoint {
  return {
    messages: [],
    rankingHistory: [],
    interventions: [],
    behavioralEvents: [],
    contributionClassifications: [],
    processedEventIds: [],
    ruleState: {},
  };
}

function makeBot() {
  const handlers: ((e: TimelineEvent) => void)[] = [];
  const bot = {
    botUserId: "@bot:localhost",
    onTimelineEvent: (h: (e: TimelineEvent) => void) => handlers.push(h),
    join: vi.fn(async () => undefined),
    joinAs: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
    ensureReady: vi.fn(async () => undefined),
    comparisonBotUserIds: vi.fn(async () => [
      "@gdm_bot_a_x:localhost",
      "@gdm_bot_b_x:localhost",
    ]),
    sendText: vi.fn(async () => undefined),
    sendTextAs: vi.fn(async () => undefined),
    getJoinedMemberIds: vi.fn(async () => ["@u:localhost", "@u2:localhost"]),
    roomHistory: vi.fn(async () => []),
  };
  return { bot: bot as unknown as MatrixBotService, emit: (e: TimelineEvent) => handlers.forEach((h) => h(e)) };
}

describe("SessionsService (chat-service)", () => {
  let emit: (e: TimelineEvent) => void;
  let bot: MatrixBotService;
  let rules: {
    onEvent: ReturnType<typeof vi.fn>;
    onWindowElapsed: ReturnType<typeof vi.fn>;
  };
  let svc: SessionsService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    ({ bot, emit } = makeBot());
    rules = { onEvent: vi.fn(), onWindowElapsed: vi.fn() };
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

  it("a failed comparison-bot join never kills the takeover — recording continues", async () => {
    (bot.joinAs as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("bot join failed (403)"),
    );
    await svc.startSession({
      ...note,
      condition: {
        ...condition,
        config: { ...condition.config, comparisonMode: true },
      },
    });

    // The runtime was registered despite the join failure: messages record.
    emit({
      roomId: "!r",
      type: "m.room.message",
      sender: "@u:localhost",
      eventId: "m1",
      ts: 1000,
      content: { body: "hi" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rules.onEvent).toHaveBeenCalled();

    (bot.joinAs as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(5000);
    // Both identities were attempted initially and again on the bounded
    // background retry; recording never stopped while they recovered.
    expect(bot.joinAs).toHaveBeenCalledTimes(4);
  });

  it("does not start the same room twice", async () => {
    await svc.startSession(note);
    await svc.startSession(note);
    expect(bot.join).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent duplicate start notifications", async () => {
    let releaseJoin!: () => void;
    (bot.join as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseJoin = resolve;
        }),
    );

    const first = svc.startSession(note);
    const duplicate = svc.startSession(note);
    await vi.waitFor(() => expect(bot.join).toHaveBeenCalledTimes(1));
    releaseJoin();
    await Promise.all([first, duplicate]);

    expect(bot.join).toHaveBeenCalledTimes(1);
  });

  it("replays uncheckpointed Matrix history before resuming a session", async () => {
    (bot.roomHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        roomId: "!r",
        type: "m.room.message",
        sender: "@u:localhost",
        eventId: "missed-during-restart",
        ts: 1000,
        content: { body: "recover me" },
      },
    ]);

    await svc.startSession({
      ...note,
      startedAt: "1970-01-01T00:00:00.000Z",
      checkpoint: emptyCheckpoint(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(bot.roomHistory).toHaveBeenCalledWith("!r", 0);
    expect(rules.onEvent).toHaveBeenCalledOnce();

    await svc.endSession("!r");
    const body = JSON.parse(
      String((fetchMock.mock.calls.at(-1)![1] as { body: string }).body),
    );
    expect(body.messages).toEqual([
      expect.objectContaining({ id: "missed-during-restart", text: "recover me" }),
    ]);
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

  it("collects messages, reactions and ranking; runs rules; records but never processes its own events", async () => {
    await svc.startSession(note);
    emit({ roomId: "!r", type: "m.room.message", sender: "@u:localhost", eventId: "m1", ts: 1000, content: { body: "hi" } });
    emit({ roomId: "!r", type: "m.reaction", sender: "@u2:localhost", eventId: "re1", ts: 1001, content: { "m.relates_to": { rel_type: "m.annotation", event_id: "m1", key: "👍" } } });
    emit({ roomId: "!r", type: "de.gdm.ranking", sender: "@u:localhost", eventId: "rk1", ts: 1002, content: { taskId: "t", order: ["a", "b"], updatedAt: "", updatedBy: "u", movement: { itemId: "a", from: 1, to: 0 } } });
    emit({ roomId: "!r", type: "de.gdm.behavior", sender: "@u:localhost", eventId: "ty1", ts: 1003, content: { type: "typing-stop", durationMs: 800 } });
    emit({ roomId: "!r", type: "m.room.redaction", sender: "@u2:localhost", eventId: "rd1", ts: 1004, content: {}, redacts: "re1" });
    emit({ roomId: "!r", type: "m.room.message", sender: "@bot:localhost", eventId: "b1", ts: 1004, content: { body: "own", "de.gdm.recipient": "@u:localhost" } });

    // Rules run for every non-own event; the bot's own message is recorded
    // for the research log but never fed to the rules.
    await vi.advanceTimersByTimeAsync(0);
    expect(rules.onEvent).toHaveBeenCalledTimes(5);

    await svc.endSession("!r");
    const lastCall = fetchMock.mock.calls.at(-1) as [string, { body: string }];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.messages).toHaveLength(2);
    expect(lastBody.messages[0].reactions).toHaveLength(0); // added then redacted
    expect(lastBody.reactionEvents).toEqual([
      expect.objectContaining({
        eventId: "re1",
        messageId: "m1",
        redacted: true,
        redactionEventId: "rd1",
      }),
    ]);
    expect(lastBody.messages[1]).toMatchObject({
      id: "b1",
      senderId: "@bot:localhost",
      recipientId: "@u:localhost",
      text: "own",
    });
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

  it("never overlaps checkpoints and follows an in-flight write with one latest snapshot", async () => {
    let finishFirst!: (response: { ok: boolean }) => void;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValue({ ok: true });
    await svc.startSession(note);

    emit({
      roomId: "!r",
      type: "m.room.message",
      sender: "@u:localhost",
      eventId: "m1",
      ts: 1000,
      content: { body: "first" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // This event arrives while the first database request is unresolved. It
    // must mark the room dirty, not start a competing full-snapshot write.
    emit({
      roomId: "!r",
      type: "m.room.message",
      sender: "@u2:localhost",
      eventId: "m2",
      ts: 2000,
      content: { body: "second" },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishFirst({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(
      String((fetchMock.mock.calls[1][1] as { body: string }).body),
    );
    expect(latest.messages.map((message: { id: string }) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("evaluates the rules at every window boundary until the session ends", async () => {
    await svc.startSession(note);
    // Default config: 3-minute warm-up, then 4-minute contribution windows —
    // no evaluation until the first window closes at minute 7.
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(rules.onWindowElapsed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(rules.onWindowElapsed).toHaveBeenCalledTimes(1);

    await svc.endSession("!r");
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(rules.onWindowElapsed).toHaveBeenCalledTimes(1);
  });

  it("does not delay a window boundary behind slow per-message rule work", async () => {
    let finishClassification!: () => void;
    rules.onEvent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClassification = resolve;
        }),
    );
    await svc.startSession({
      ...note,
      condition: {
        ...condition,
        config: {
          ...condition.config,
          protectedStartMinutes: 0,
          contributionWindowMinutes: 1,
        },
      },
    });
    emit({
      roomId: "!r",
      type: "m.room.message",
      sender: "@u:localhost",
      eventId: "slow-classification",
      ts: Date.now(),
      content: { body: "a message awaiting an external classifier" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rules.onEvent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(rules.onWindowElapsed).toHaveBeenCalledTimes(1);

    finishClassification();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("finalizes automatically when the discussion timer ends", async () => {
    await svc.startSession(note);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/finalize"),
      expect.any(Object),
    );
  });

  it("flushes an unscheduled latest snapshot during graceful shutdown", async () => {
    await svc.startSession(note);
    emit({
      roomId: "!r",
      type: "m.room.message",
      sender: "@u:localhost",
      eventId: "shutdown-message",
      ts: 1000,
      content: { body: "persist me before restart" },
    });
    await vi.advanceTimersByTimeAsync(0);

    // The normal one-second debounce has not fired yet.
    expect(fetchMock).not.toHaveBeenCalled();
    await svc.beforeApplicationShutdown();

    expect(bot.stop).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/checkpoint"),
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as { body: string }).body),
    );
    expect(body.messages).toEqual([
      expect.objectContaining({ id: "shutdown-message" }),
    ]);
  });

  it("endSession is idempotent", async () => {
    await svc.startSession(note);
    await svc.endSession("!r");
    fetchMock.mockClear();
    await svc.endSession("!r");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
