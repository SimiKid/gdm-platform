import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_INTERVENTION_CONFIG,
  GDM_RECIPIENT_KEY,
} from "@gdm/shared";
import type { Condition, InterventionMode, Message } from "@gdm/shared";
import type { MatrixBotService, TimelineEvent } from "../matrix/matrix-bot.service";
import { SessionRuntime } from "../sessions/session-runtime";
import { ContributionBotRules, NoopBotRules, StudyBotRules } from "./bot-rules";
import type { ClassifierContext } from "../classifier/contribution-classifier";

const MEMBERS = [
  "@gdm_a:localhost",
  "@gdm_b:localhost",
  "@gdm_c:localhost",
];

function condition(mode: InterventionMode, overrides = {}): Condition {
  return {
    id: mode,
    name: mode,
    active: true,
    goal: 5,
    durationMinutes: 10,
    groupSize: 3,
    config: {
      ...DEFAULT_INTERVENTION_CONFIG,
      interventionMode: mode,
      protectedStartMinutes: 0,
      protectedEndMinutes: 0,
      cooldownSeconds: 120,
      contributionThreshold: 0.4,
      ...overrides,
      scoreWeights: {
        ...DEFAULT_INTERVENTION_CONFIG.scoreWeights,
        ...("scoreWeights" in overrides
          ? (overrides as { scoreWeights: Record<string, number> }).scoreWeights
          : {}),
      },
    },
  };
}

function fakeBot() {
  return {
    botUserId: "@gdm_bot:localhost",
    sendText: vi.fn(async () => undefined),
    sendTextAs: vi.fn(async () => undefined),
    getJoinedMemberIds: vi.fn(async () => MEMBERS),
  } as unknown as MatrixBotService;
}

function runtime(mode: InterventionMode, overrides = {}) {
  const bot = fakeBot();
  const rt = new SessionRuntime("s", "!r", condition(mode, overrides), 10, bot);
  return { rt, bot };
}

function record(
  rt: SessionRuntime,
  sender: string,
  text: string,
  eventId = crypto.randomUUID(),
  ts = Date.now() + 60_000,
): TimelineEvent {
  const message: Message = {
    id: eventId,
    timestamp: new Date(ts).toISOString(),
    senderId: sender,
    recipientId: null,
    text,
    reactions: [],
  };
  rt.recordMessage(message);
  return {
    roomId: rt.roomId,
    type: "m.room.message",
    sender,
    eventId,
    ts,
    content: { body: text },
  };
}

function fakeClassification(
  message: Message,
  context: ClassifierContext,
  overrides: { meaningfulnessScore?: number; invitesParticipation?: boolean } = {},
) {
  const invites = overrides.invitesParticipation ?? false;
  return {
    messageId: message.id,
    senderId: message.senderId,
    classifiedAt: new Date().toISOString(),
    respondsToPrior: { value: true, reason: "builds on a prior message" },
    referencesTaskItem: { value: true, reason: "names a task item" },
    hasDiscussionStructure: { value: false, reason: "no explicit stance" },
    invitesParticipation: { value: invites, reason: invites ? "asks the group" : "no invitation" },
    meaningfulnessScore: overrides.meaningfulnessScore ?? 2 / 3,
    model: "test-model",
    promptVersion: "test-v1",
    prompt: context.priorMessages.map((item) => item.id).join(","),
    rawOutput: "{}",
  };
}

async function makeDominantRed(
  mode: InterventionMode,
  overrides = {},
): Promise<{ rt: SessionRuntime; bot: MatrixBotService; event: TimelineEvent }> {
  const { rt, bot } = runtime(mode, overrides);
  record(rt, MEMBERS[1], "ok", "m-blue");
  const event = record(
    rt,
    MEMBERS[0],
    "I think oxygen matters most because without oxygen we cannot move or breathe at all on the lunar surface today.",
    "m-red",
  );
  return { rt, bot, event };
}

describe("ContributionBotRules", () => {
  it("public modes nudge the top contributor with their own percentage only", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    await new ContributionBotRules().onEvent(rt, event);

    // Red: 2.0 of 3.05 points → 66%. Template #1 of the rotation.
    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      "@Red, you've brought a lot of energy to this — 66% of the airtime so far! Might be a good moment to hear from the others, too.",
    );
    expect(rt.interventions[0]).toMatchObject({
      mode: "public",
      audience: "public",
      targets: [{ userId: MEMBERS[0], identityName: "Red" }],
    });
  });

  it("never reveals the other members' names or percentages in the nudge", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    await new ContributionBotRules().onEvent(rt, event);

    const message = (bot.sendText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(message).toContain("@Red");
    expect(message).toContain("66%");
    expect(message).not.toContain("Blue");
    expect(message).not.toContain("Green");
    expect(message).not.toContain("34%");
    // The full split is still available for analysis in the audit log.
    expect(rt.interventions[0].contributionSplit).toHaveLength(3);
  });

  it("private mode sends the identical text, only to the dominating member", async () => {
    const { rt, bot, event } = await makeDominantRed("private");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      "@Red, you've brought a lot of energy to this — 66% of the airtime so far! Might be a good moment to hear from the others, too.",
      expect.objectContaining({ [GDM_RECIPIENT_KEY]: MEMBERS[0] }),
    );
    expect(rt.interventions[0]).toMatchObject({
      mode: "private",
      audience: "private",
    });
  });

  it("baseline mode never sends any intervention", async () => {
    const { rt, bot, event } = await makeDominantRed("baseline");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
  });

  it("protected start and end windows suppress nudges", async () => {
    const start = await makeDominantRed("public", {
      protectedStartMinutes: 3,
    });
    await new ContributionBotRules().onEvent(start.rt, {
      ...start.event,
      ts: start.rt.startedAtMs + 60_000,
    });
    expect(start.bot.sendText).not.toHaveBeenCalled();

    const end = await makeDominantRed("public", {
      protectedEndMinutes: 2,
    });
    await new ContributionBotRules().onEvent(end.rt, {
      ...end.event,
      ts: end.rt.startedAtMs + 9 * 60_000,
    });
    expect(end.bot.sendText).not.toHaveBeenCalled();
  });

  it("applies the global cooldown to every further nudge, regardless of target", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    const rules = new ContributionBotRules();
    await rules.onEvent(rt, event);

    // A different member dominating inside the cooldown must also stay unnudged.
    const second = record(
      rt,
      MEMBERS[1],
      "Blue suddenly writes a really long dominant message with many many words.",
      "m-blue-2",
      event.ts + 30_000,
    );
    await rules.onEvent(rt, second);

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(rt.interventions).toHaveLength(1);
  });

  it("resets the contribution tracker after a nudge (equal turns, not equal session)", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    const rules = new ContributionBotRules();
    await rules.onEvent(rt, event);

    // After the cooldown, Red's pre-nudge dominance no longer counts: Blue is
    // the only contributor since the reset and becomes the new target.
    const later = record(
      rt,
      MEMBERS[1],
      "One single new message from Blue after the reset.",
      "m-blue-2",
      event.ts + 121_000,
    );
    await rules.onEvent(rt, later);

    expect(bot.sendText).toHaveBeenCalledTimes(2);
    expect(rt.interventions[1].targets).toEqual([
      { userId: MEMBERS[1], identityName: "Blue" },
    ]);
    const split = rt.interventions[1].contributionSplit;
    expect(split.find((entry) => entry.userId === MEMBERS[0])?.share).toBe(0);
    expect(split.find((entry) => entry.userId === MEMBERS[1])?.share).toBe(1);
    // The second nudge rotates to the next template variant.
    expect(rt.interventions[1].message).toBe(
      "@Blue, you're leading the discussion right now at 100% of the messages. Curious what the rest of the group thinks — want to pull them in?",
    );
  });

  it("uses the composite dominance score when the classifier is active", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt, bot } = runtime("public", {
      llmMode: "active",
      contributionThreshold: 0.52,
    });
    const rules = new ContributionBotRules({ classify });
    const ts = Date.now() + 60_000;
    // Identical raw contribution: 50% share each — rule-based detection would
    // stay silent at a 0.52 threshold.
    record(rt, MEMBERS[1], "same amount of words here", "m-blue", ts);
    const event = record(rt, MEMBERS[0], "same amount of words okay", "m-red", ts + 1_000);

    await rules.onEvent(rt, event);

    // Red's classified meaningfulness lifts them over: 0.9×0.5 + 0.1×1 = 0.55.
    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(rt.interventions[0]).toMatchObject({
      llmMode: "active",
      targets: [{ userId: MEMBERS[0], identityName: "Red" }],
    });
    const red = rt.interventions[0].contributionSplit.find(
      (entry) => entry.userId === MEMBERS[0],
    );
    expect(red?.share).toBeCloseTo(0.5);
    expect(red?.meaningfulnessScore).toBe(1);
    expect(red?.dominanceScore).toBeCloseTo(0.55);
  });

  it("keeps shadow-mode classifications out of the trigger decision", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt, bot } = runtime("public", {
      llmMode: "shadow",
      contributionThreshold: 0.52,
    });
    const rules = new ContributionBotRules({ classify });
    const ts = Date.now() + 60_000;
    record(rt, MEMBERS[1], "same amount of words here", "m-blue", ts);
    const event = record(rt, MEMBERS[0], "same amount of words okay", "m-red", ts + 1_000);

    await rules.onEvent(rt, event);

    expect(rt.contributionClassifications).toHaveLength(1);
    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
  });

  it("grants a grace period to a dominant member whose message invites others", async () => {
    const classify = vi.fn(
      async (message: Message, context: ClassifierContext) =>
        fakeClassification(message, context, {
          invitesParticipation: message.id === "m-red-invite",
        }),
    );
    const { rt, bot } = runtime("public", { llmMode: "active" });
    const rules = new ContributionBotRules({ classify });
    const ts = Date.now() + 60_000;
    record(rt, MEMBERS[1], "ok", "m-blue", ts);
    const invite = record(
      rt,
      MEMBERS[0],
      "I think oxygen matters most - but what do the rest of you think?",
      "m-red-invite",
      ts + 1_000,
    );
    await rules.onEvent(rt, invite);
    // Dominant, but self-correcting: the invite suppresses the flag.
    expect(bot.sendText).not.toHaveBeenCalled();

    // Still dominant once the 60s grace expired, and no new invitation.
    const followUp = record(
      rt,
      MEMBERS[0],
      "Here is even more of my own reasoning about the oxygen ranking.",
      "m-red-2",
      invite.ts + 61_000,
    );
    await rules.onEvent(rt, followUp);
    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(rt.interventions[0].targets[0].userId).toBe(MEMBERS[0]);
  });

  it("uses the rolling contribution window for dominance checks", async () => {
    const { rt, bot } = runtime("public", {
      contributionWindowMinutes: 1,
    });
    const now = rt.startedAtMs + 5 * 60_000;
    record(
      rt,
      MEMBERS[0],
      "A very long old contribution that should be outside the window.",
      "old-red",
      now - 2 * 60_000,
    );
    record(rt, MEMBERS[1], "Recent blue contribution.", "recent-blue", now);

    await new ContributionBotRules().onEvent(rt, {
      roomId: rt.roomId,
      type: "m.room.message",
      sender: MEMBERS[1],
      eventId: "recent-blue",
      ts: now,
      content: { body: "Recent blue contribution." },
    });

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("@Blue"),
    );
    expect(rt.interventions[0].targets[0]).toMatchObject({
      userId: MEMBERS[1],
      identityName: "Blue",
    });
  });

  it("records shadow-mode classifications with task and member context without nudging", async () => {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "shadow";
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context),
    );
    const { rt, bot } = runtime("baseline");
    const rules = new ContributionBotRules({ classify });
    const start = rt.startedAtMs;

    try {
      await rules.onEvent(
        rt,
        record(rt, MEMBERS[0], "We should rank oxygen first.", "idea", start),
      );

      expect(rt.contributionClassifications).toHaveLength(1);
      expect(rt.contributionClassifications[0]).toMatchObject({
        messageId: "idea",
        senderId: MEMBERS[0],
        meaningfulnessScore: 2 / 3,
      });
      const [, context] = classify.mock.calls[0];
      expect(context.participantIds).toEqual(MEMBERS);
      expect(context.taskItems).toContain("Two 100-lb tanks of oxygen");
      expect(bot.sendText).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
  });

  it("classifies the message for each event when later messages are already buffered", async () => {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "shadow";
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context),
    );
    const { rt, bot } = runtime("baseline");
    const rules = new ContributionBotRules({ classify });
    const start = rt.startedAtMs;
    const events = [
      record(rt, MEMBERS[0], "We should rank oxygen first.", "idea", start),
      record(rt, MEMBERS[1], "What about water?", "later-1", start + 1_000),
      record(rt, MEMBERS[2], "I prefer the map.", "later-2", start + 2_000),
    ];

    try {
      for (const event of events) await rules.onEvent(rt, event);

      expect(classify.mock.calls.map(([message]) => message.id)).toEqual([
        "idea",
        "later-1",
        "later-2",
      ]);
      expect(
        classify.mock.calls.map(([, context]) =>
          context.priorMessages.map((message) => message.id),
        ),
      ).toEqual([[], ["idea"], ["idea", "later-1"]]);
      expect(
        rt.contributionClassifications.map((classification) =>
          classification.messageId,
        ),
      ).toEqual(["idea", "later-1", "later-2"]);
      expect(bot.sendText).not.toHaveBeenCalled();
    } finally {
      if (previousMode === undefined) delete process.env.LLM_MODE;
      else process.env.LLM_MODE = previousMode;
    }
  });
});

describe("StudyBotRules (two-bot comparison mode)", () => {
  it("runs both detection arms with their own bot identities and state", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt, bot } = runtime("public", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    record(rt, MEMBERS[1], "ok", "m-blue");
    const event = record(
      rt,
      MEMBERS[0],
      "I think oxygen matters most because without oxygen we cannot move or breathe at all on the lunar surface today.",
      "m-red",
    );

    await rules.onEvent(rt, event);

    // Assistant A (rule-based) and Assistant B (rule+LLM) both nudge publicly.
    expect(bot.sendTextAs).toHaveBeenCalledWith(
      "a",
      "!r",
      expect.stringContaining("a lot of energy"),
    );
    expect(bot.sendTextAs).toHaveBeenCalledWith(
      "b",
      "!r",
      expect.stringContaining("a lot of energy"),
    );
    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions.map((item) => item.llmMode)).toEqual(["off", "active"]);
    expect(rt.interventions.every((item) => item.audience === "public")).toBe(true);
    // Independent cooldown/reset/grace state per arm.
    expect(rt.state["contributionBotRules:A"]).toBeDefined();
    expect(rt.state["contributionBotRules:B"]).toBeDefined();
    // Only the LLM arm classifies, and each message only once.
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("delegates to the single engine when comparison mode is off", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    await new StudyBotRules().onEvent(rt, event);

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.sendTextAs).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(1);
  });
});

describe("NoopBotRules", () => {
  it("onEvent does nothing and never throws", () => {
    const { rt } = runtime("public");
    expect(() =>
      new NoopBotRules().onEvent(rt, {} as TimelineEvent),
    ).not.toThrow();
  });
});
