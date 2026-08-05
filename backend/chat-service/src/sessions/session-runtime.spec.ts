import { describe, it, expect, vi } from "vitest";
import { SessionRuntime } from "./session-runtime";
import type { MatrixBotService } from "../matrix/matrix-bot.service";
import { DEFAULT_INTERVENTION_CONFIG } from "@gdm/shared";
import type { Condition, Message } from "@gdm/shared";

const condition: Condition = {
  id: "c",
  name: "C",
  active: true,
  goal: 5,
  durationMinutes: 10,
  groupSize: 3,
  config: { ...DEFAULT_INTERVENTION_CONFIG },
};

function fakeBot() {
  return {
    botUserId: "@bot:localhost",
    sendText: vi.fn(async () => undefined),
    getJoinedMemberIds: vi.fn(async () => [
      "@gdm_a:localhost",
      "@gdm_bot_x:localhost",
      "@gdm_orchestrator_x:localhost",
    ]),
  } as unknown as MatrixBotService;
}

const message = (id: string): Message => ({
  id,
  timestamp: "now",
  senderId: "@u:localhost",
  recipientId: null,
  text: "hi",
  reactions: [],
});

describe("SessionRuntime", () => {
  it("records messages and indexes them by id", () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    rt.recordMessage(message("m1"));
    expect(rt.messages).toHaveLength(1);
  });

  it("attaches a reaction to its target message, and removes it on redaction", () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    rt.recordMessage(message("m1"));
    rt.addReaction("re1", "m1", {
      key: "👍",
      senderId: "@u2:localhost",
      timestamp: "now",
    });
    expect(rt.messages[0].reactions).toHaveLength(1);

    rt.removeRedacted("re1");
    expect(rt.messages[0].reactions).toHaveLength(0);
  });

  it("keeps a redacted reaction as an audit tombstone across restart", () => {
    const first = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    first.recordMessage(message("m1"));
    first.addReaction("re1", "m1", {
      key: "👍",
      senderId: "@u2:localhost",
      timestamp: "2026-08-05T10:00:00.000Z",
    });

    const restored = new SessionRuntime(
      "s",
      "!r",
      condition,
      10,
      fakeBot(),
      undefined,
      first.checkpoint(),
    );
    restored.removeRedacted(
      "re1",
      "rd1",
      "2026-08-05T10:00:01.000Z",
    );

    const checkpoint = restored.checkpoint();
    expect(checkpoint.messages[0].reactions).toEqual([]);
    expect(checkpoint.reactionEvents).toEqual([
      expect.objectContaining({
        eventId: "re1",
        messageId: "m1",
        redacted: true,
        redactionEventId: "rd1",
      }),
    ]);
    expect(checkpoint.redactedReactionEventIds).toEqual(["re1"]);
  });

  it("ignores reactions to unknown messages and unknown redactions", () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    rt.addReaction("re1", "missing", {
      key: "👍",
      senderId: "@u:localhost",
      timestamp: "now",
    });
    rt.removeRedacted("nope"); // no throw
    expect(rt.messages).toHaveLength(0);
  });

  it("records ranking history in order", () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    rt.recordRanking({ taskId: "t", order: ["a"], updatedAt: "1", updatedBy: "u" });
    rt.recordRanking({ taskId: "t", order: ["b"], updatedAt: "2", updatedBy: "u" });
    expect(rt.rankingHistory.map((r) => r.order[0])).toEqual(["a", "b"]);
  });

  it("post sends a group message; postPrivate tags the recipient", async () => {
    const bot = fakeBot();
    const rt = new SessionRuntime("s", "!r", condition, 10, bot);
    await rt.post("hello");
    expect(bot.sendText).toHaveBeenCalledWith("!r", "hello");

    await rt.postPrivate("@u:localhost", "psst");
    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      "psst",
      expect.objectContaining({ "de.gdm.recipient": "@u:localhost" }),
    );
  });

  it("markEnded flips the ended flag", () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    expect(rt.isEnded).toBe(false);
    rt.markEnded();
    expect(rt.isEnded).toBe(true);
  });

  it("returns participant member ids without Matrix service accounts", async () => {
    const rt = new SessionRuntime("s", "!r", condition, 10, fakeBot());
    await expect(rt.getParticipantUserIds()).resolves.toEqual([
      "@gdm_a:localhost",
    ]);
  });
});
