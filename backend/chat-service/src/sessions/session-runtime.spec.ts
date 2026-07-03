import { describe, it, expect, vi } from "vitest";
import { SessionRuntime } from "./session-runtime";
import type { MatrixBotService } from "../matrix/matrix-bot.service";
import type { Condition, Message } from "@gdm/shared";

const condition: Condition = {
  id: "c",
  name: "C",
  active: true,
  goal: 5,
  durationMinutes: 10,
  groupSize: 3,
  config: {},
};

function fakeBot() {
  return {
    botUserId: "@bot:localhost",
    sendText: vi.fn(async () => undefined),
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
    const rt = new SessionRuntime("s", "!r", condition, fakeBot());
    rt.recordMessage(message("m1"));
    expect(rt.messages).toHaveLength(1);
  });

  it("attaches a reaction to its target message, and removes it on redaction", () => {
    const rt = new SessionRuntime("s", "!r", condition, fakeBot());
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

  it("ignores reactions to unknown messages and unknown redactions", () => {
    const rt = new SessionRuntime("s", "!r", condition, fakeBot());
    rt.addReaction("re1", "missing", {
      key: "👍",
      senderId: "@u:localhost",
      timestamp: "now",
    });
    rt.removeRedacted("nope"); // no throw
    expect(rt.messages).toHaveLength(0);
  });

  it("records ranking history in order", () => {
    const rt = new SessionRuntime("s", "!r", condition, fakeBot());
    rt.recordRanking({ taskId: "t", order: ["a"], updatedAt: "1", updatedBy: "u" });
    rt.recordRanking({ taskId: "t", order: ["b"], updatedAt: "2", updatedBy: "u" });
    expect(rt.rankingHistory.map((r) => r.order[0])).toEqual(["a", "b"]);
  });

  it("post sends a group message; postPrivate tags the recipient", async () => {
    const bot = fakeBot();
    const rt = new SessionRuntime("s", "!r", condition, bot);
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
    const rt = new SessionRuntime("s", "!r", condition, fakeBot());
    expect(rt.isEnded).toBe(false);
    rt.markEnded();
    expect(rt.isEnded).toBe(true);
  });
});
