import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { GDM_RECIPIENT_KEY } from "@gdm/shared";
import type { Condition } from "@gdm/shared";
import { SessionsService } from "../../src/sessions/sessions.service";
import {
  createChatApp,
  createPublicRoom,
  joinRoom,
  joinedMembers,
  redactEvent,
  registerUser,
  roomMessages,
  sendRanking,
  sendReaction,
  sendText,
  startFakeSessionManager,
  testCondition,
  until,
  type ChatApp,
  type FakeSessionManager,
  type MatrixUser,
} from "./harness";

/**
 * The chat-service against a real Synapse: the bot's registration, sync
 * loop, event normalisation, the contribution rules and the finalize
 * callback all run for real. Only the Session Manager is a fake recorder.
 */
describe("chat-service ↔ real Synapse (integration)", () => {
  let fakeSm: FakeSessionManager;
  let t: ChatApp;

  beforeAll(async () => {
    fakeSm = await startFakeSessionManager();
    t = await createChatApp(fakeSm.url);
  });

  afterAll(async () => {
    await t.close();
    await fakeSm.close();
  });

  /** Provision a room the way the session-manager would, then hand it over. */
  async function startSession(
    creator: MatrixUser,
    others: MatrixUser[],
    condition: Condition,
    durationMinutes: number,
  ): Promise<{ sessionId: string; roomId: string }> {
    const roomId = await createPublicRoom(creator, `GDM it · ${condition.id}`);
    for (const user of others) await joinRoom(user, roomId);

    const sessionId = randomUUID();
    await request(t.http)
      .post("/internal/sessions/start")
      .send({ sessionId, roomId, condition, durationMinutes })
      .expect(201);

    await until(
      async () => (await joinedMembers(creator, roomId)).includes(t.bot.botUserId),
      "the bot to join the room",
    );
    return { sessionId, roomId };
  }

  const finalizeFor = (sessionId: string, timeoutMs: number) =>
    until(
      () =>
        fakeSm.calls.find(
          (call) => call.path === `/sessions/${sessionId}/finalize`,
        ),
      `finalize callback for session ${sessionId}`,
      timeoutMs,
    );

  const botMessageIn = (user: MatrixUser, roomId: string) =>
    until(
      async () =>
        (await roomMessages(user, roomId)).find(
          (ev) => ev.type === "m.room.message" && ev.sender === t.bot.botUserId,
        ),
      "a bot message in the room",
    );

  it("joins the room when the session manager hands over a session", async () => {
    const alice = await registerUser("alice");
    const berta = await registerUser("berta");
    await startSession(alice, [berta], testCondition("baseline"), 10);
  });

  it("collects the discussion through its sync loop and finalizes on the timer", async () => {
    const alice = await registerUser("alice");
    const berta = await registerUser("berta");
    // 0.25 min = 15s server-side discussion timer.
    const { sessionId, roomId } = await startSession(
      alice,
      [berta],
      testCondition("baseline"),
      0.25,
    );

    const m1 = await sendText(alice, roomId, "I say oxygen tanks first");
    const m2 = await sendText(berta, roomId, "Water matters more than heat");
    const upvote = await sendReaction(berta, roomId, m1, "👍");
    await sendReaction(alice, roomId, m2, "🚀");
    // Toggle the 👍 off again — the redaction must undo it in the record.
    await redactEvent(berta, roomId, upvote);
    await sendRanking(berta, roomId, {
      taskId: "moon-survival",
      order: ["oxygen", "water", "food"],
      updatedAt: new Date().toISOString(),
      updatedBy: berta.userId,
    });

    const call = await finalizeFor(sessionId, 40_000);
    expect(call.path).toBe(`/sessions/${sessionId}/finalize`);

    expect(call.body.messages).toHaveLength(2);
    const [first, second] = call.body.messages;
    expect(first).toMatchObject({
      id: m1,
      senderId: alice.userId,
      text: "I say oxygen tanks first",
      reactions: [], // the 👍 was redacted
    });
    expect(second).toMatchObject({
      id: m2,
      senderId: berta.userId,
      text: "Water matters more than heat",
    });
    expect(second.reactions).toEqual([
      expect.objectContaining({ key: "🚀", senderId: alice.userId }),
    ]);

    expect(call.body.rankingHistory).toEqual([
      expect.objectContaining({
        taskId: "moon-survival",
        order: ["oxygen", "water", "food"],
        updatedBy: berta.userId,
      }),
    ]);

    // Baseline arm: the bot observes silently.
    expect(call.body.interventions).toEqual([]);
    const events = await roomMessages(alice, roomId);
    expect(events.some((ev) => ev.sender === t.bot.botUserId && ev.type === "m.room.message")).toBe(false);
  });

  it("posts one public nudge when a participant dominates and logs it in finalize", async () => {
    const alice = await registerUser("alice");
    const berta = await registerUser("berta");
    // 0.3 min = 18s timer; the nudge must fire well before that.
    const { sessionId, roomId } = await startSession(
      alice,
      [berta],
      testCondition("public"),
      0.3,
    );

    await sendText(alice, roomId, "I have a long and detailed plan for the oxygen tanks.");
    await sendText(alice, roomId, "Also the water: we ration it across ten days, easily.");
    await sendText(berta, roomId, "ok");

    const nudge = await botMessageIn(alice, roomId);
    // First nudge in a session uses the first template variant, addressing
    // only the top contributor with their own percentage.
    expect(nudge.content.body).toContain("a lot of energy");
    expect(nudge.content.body).toContain("% of the airtime");
    expect(nudge.content.body).not.toContain("Current participation split");
    // Public nudge: no private-recipient key.
    expect(nudge.content[GDM_RECIPIENT_KEY]).toBeUndefined();

    const call = await finalizeFor(sessionId, 40_000);
    // The global cooldown blocks a second nudge, so exactly one is logged.
    expect(call.body.interventions).toHaveLength(1);
    const logged = call.body.interventions![0];
    expect(logged).toMatchObject({
      sessionId,
      roomId,
      mode: "public",
      audience: "public",
      trigger: "contribution-threshold",
    });
    expect(logged.targets).toEqual([
      expect.objectContaining({ userId: alice.userId }),
    ]);
    expect(logged.message).toBe(nudge.content.body);
    // The bot's own nudge is never part of the recorded discussion.
    expect(call.body.messages.map((m) => m.senderId)).toEqual([
      alice.userId,
      alice.userId,
      berta.userId,
    ]);
  });

  it("sends private nudges with the recipient key, visible in the finalize log", async () => {
    const alice = await registerUser("alice");
    const berta = await registerUser("berta");
    // Long timer: this test ends the session explicitly instead.
    const { sessionId, roomId } = await startSession(
      alice,
      [berta],
      testCondition("private"),
      10,
    );

    await sendText(alice, roomId, "Let me summarise everything myself at length here.");
    await sendText(berta, roomId, "hm");

    const nudge = await botMessageIn(alice, roomId);
    // Soft privacy: the event carries the recipient; clients filter on it.
    expect(nudge.content[GDM_RECIPIENT_KEY]).toBe(alice.userId);
    // Private delivery uses the identical template texts (no confounds).
    expect(nudge.content.body).toContain("a lot of energy");

    // End the session the way the timer would, and check the handover.
    await t.moduleRef.get(SessionsService).endSession(roomId);
    const call = await finalizeFor(sessionId, 10_000);
    expect(call.body.interventions).toHaveLength(1);
    expect(call.body.interventions![0]).toMatchObject({
      audience: "private",
      targets: [expect.objectContaining({ userId: alice.userId })],
    });
  });

  it("comparison mode: Assistant A and Assistant B both nudge in the same room", async () => {
    const alice = await registerUser("alice");
    const berta = await registerUser("berta");
    const condition = testCondition("public");
    condition.config.comparisonMode = true;
    const { sessionId, roomId } = await startSession(alice, [berta], condition, 10);

    // One dominant message triggers both detection arms (without an API key
    // the LLM arm falls back to 0.9 × share, still above the threshold).
    await sendText(
      alice,
      roomId,
      "My extensive oxygen plan covers rations suits water and every possible route across the lunar surface for the whole crew.",
    );

    const nudges = await until(async () => {
      const events = (await roomMessages(alice, roomId)).filter(
        (ev) => ev.type === "m.room.message" && /_bot_[ab]_/.test(ev.sender),
      );
      return events.length >= 2 ? events : undefined;
    }, "both comparison bots to nudge");

    const senders = nudges.map((ev) => ev.sender);
    expect(senders.some((sender) => /_bot_a_/.test(sender))).toBe(true);
    expect(senders.some((sender) => /_bot_b_/.test(sender))).toBe(true);
    for (const nudge of nudges) {
      expect(nudge.content.body).toContain("a lot of energy");
      // Comparison nudges are always public.
      expect(nudge.content[GDM_RECIPIENT_KEY]).toBeUndefined();
    }

    await t.moduleRef.get(SessionsService).endSession(roomId);
    const call = await finalizeFor(sessionId, 10_000);
    expect(call.body.interventions).toHaveLength(2);
    expect(call.body.interventions!.map((item) => item.llmMode).sort()).toEqual([
      "active",
      "off",
    ]);
    // The comparison bots' own nudges never count as discussion messages.
    expect(call.body.messages.map((m) => m.senderId)).toEqual([alice.userId]);
  });
});
