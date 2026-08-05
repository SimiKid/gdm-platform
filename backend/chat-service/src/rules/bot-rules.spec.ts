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
  it("uses a newly generated friendly message without changing the target or percentage", async () => {
    const generated =
      "Thanks for the thoughtful momentum, @Red — you've contributed 66% so far. Would you like to invite another voice into the next step?";
    const generate = vi.fn(async () => generated);
    const { rt, bot, event } = await makeDominantRed("public");

    await new ContributionBotRules(undefined, {}, { generate }).onWindowElapsed(
      rt,
      event.ts + 1_000,
    );

    expect(generate).toHaveBeenCalledWith({
      targetName: "Red",
      contributionPercent: 66,
      otherParticipantNames: ["Blue", "Green"],
      previousMessages: [],
    });
    expect(bot.sendText).toHaveBeenCalledWith("!r", generated);
    expect(rt.interventions[0]).toMatchObject({
      targets: [{ userId: MEMBERS[0], identityName: "Red" }],
      message: generated,
    });
  });

  it("keeps nudging with a fixed fallback when generation fails", async () => {
    const generate = vi.fn(async () => {
      throw new Error("temporary outage");
    });
    const { rt, bot, event } = await makeDominantRed("public");

    await new ContributionBotRules(undefined, {}, { generate }).onWindowElapsed(
      rt,
      event.ts + 1_000,
    );

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("@Red"),
    );
    expect(rt.interventions).toHaveLength(1);
  });

  it("public modes nudge the top contributor at the window end with their own percentage only", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

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
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

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
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

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
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
  });

  it("protected start and end windows suppress nudges", async () => {
    const start = await makeDominantRed("public", {
      protectedStartMinutes: 3,
    });
    await new ContributionBotRules().onWindowElapsed(
      start.rt,
      start.rt.startedAtMs + 60_000,
    );
    expect(start.bot.sendText).not.toHaveBeenCalled();

    const end = await makeDominantRed("public", {
      protectedEndMinutes: 2,
    });
    await new ContributionBotRules().onWindowElapsed(
      end.rt,
      end.rt.startedAtMs + 9 * 60_000,
    );
    expect(end.bot.sendText).not.toHaveBeenCalled();
  });

  it("never counts warm-up contributions, even when a window overlaps the warm-up", async () => {
    const { rt, bot } = runtime("public", { protectedStartMinutes: 2 });
    // Red dominates while the others are still arriving (inside the 2-minute
    // warm-up)...
    record(
      rt,
      MEMBERS[0],
      "A long and dominant warm-up message from Red while the others are still arriving here.",
      "warmup-red",
      rt.startedAtMs + 90_000,
    );
    // ...then only Blue contributes after the warm-up.
    record(
      rt,
      MEMBERS[1],
      "Blue's first real message.",
      "m-blue",
      rt.startedAtMs + 3 * 60_000,
    );
    // A boundary whose 4-minute span reaches back into the warm-up: Red's
    // message sits inside the span but must stay invisible.
    await new ContributionBotRules().onWindowElapsed(
      rt,
      rt.startedAtMs + 5 * 60_000,
    );

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(rt.interventions[0].targets).toEqual([
      { userId: MEMBERS[1], identityName: "Blue" },
    ]);
    const split = rt.interventions[0].contributionSplit;
    expect(split.find((entry) => entry.userId === MEMBERS[0])?.share).toBe(0);
    expect(split.find((entry) => entry.userId === MEMBERS[1])?.share).toBe(1);
  });

  it("resets the contribution tracker after a nudge (equal turns, not equal session)", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    const rules = new ContributionBotRules();
    await rules.onWindowElapsed(rt, event.ts + 1_000);

    // Next window: Red's pre-nudge dominance no longer counts. Blue is the
    // only contributor since the reset and becomes the new target.
    const later = record(
      rt,
      MEMBERS[1],
      "One single new message from Blue after the reset.",
      "m-blue-2",
      event.ts + 30_000,
    );
    await rules.onWindowElapsed(rt, later.ts + 1_000);

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

    // A window with no fresh contributions stays silent.
    await rules.onWindowElapsed(rt, later.ts + 5 * 60_000);
    expect(bot.sendText).toHaveBeenCalledTimes(2);
    expect(rt.interventions).toHaveLength(2);
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
    await rules.onWindowElapsed(rt, event.ts + 1_000);

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
    await rules.onWindowElapsed(rt, invite.ts + 1_000);
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
    await rules.onWindowElapsed(rt, followUp.ts + 1_000);
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

    await new ContributionBotRules().onWindowElapsed(rt, now);

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("@Blue"),
    );
    expect(rt.interventions[0].targets[0]).toMatchObject({
      userId: MEMBERS[1],
      identityName: "Blue",
    });
  });

  it("records classifications with task and member context without nudging", async () => {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "active";
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
    process.env.LLM_MODE = "active";
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
    await rules.onWindowElapsed(rt, event.ts + 1_000);

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
    // Independent reset/grace state per arm.
    expect(rt.state["contributionBotRules:A"]).toBeDefined();
    expect(rt.state["contributionBotRules:B"]).toBeDefined();
    // Only the LLM arm classifies, and each message only once.
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("keeps both comparison bots private in a private condition", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt, bot } = runtime("private", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    record(rt, MEMBERS[1], "ok", "m-blue");
    const event = record(
      rt,
      MEMBERS[0],
      "I think oxygen matters most because without oxygen we cannot move or breathe at all on the lunar surface today.",
      "m-red",
    );

    await rules.onEvent(rt, event);
    await rules.onWindowElapsed(rt, event.ts + 1_000);

    // A and B both nudge, but only the dominating member may see either.
    expect(bot.sendTextAs).toHaveBeenCalledWith(
      "a",
      "!r",
      expect.stringContaining("a lot of energy"),
      expect.objectContaining({ [GDM_RECIPIENT_KEY]: MEMBERS[0] }),
    );
    expect(bot.sendTextAs).toHaveBeenCalledWith(
      "b",
      "!r",
      expect.stringContaining("a lot of energy"),
      expect.objectContaining({ [GDM_RECIPIENT_KEY]: MEMBERS[0] }),
    );
    expect(rt.interventions.every((item) => item.audience === "private")).toBe(
      true,
    );
  });

  it("comparison bots never nudge in a baseline condition", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt, bot } = runtime("baseline", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    record(rt, MEMBERS[1], "ok", "m-blue");
    const event = record(
      rt,
      MEMBERS[0],
      "I think oxygen matters most because without oxygen we cannot move or breathe at all on the lunar surface today.",
      "m-red",
    );

    await rules.onEvent(rt, event);
    await rules.onWindowElapsed(rt, event.ts + 1_000);

    expect(bot.sendTextAs).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
  });

  it("starts message classifications concurrently", async () => {
    const pending: Array<{
      message: Message;
      context: ClassifierContext;
      resolve: (value: ReturnType<typeof fakeClassification>) => void;
    }> = [];
    const classify = vi.fn(
      (message: Message, context: ClassifierContext) =>
        new Promise<ReturnType<typeof fakeClassification>>((resolve) => {
          pending.push({ message, context, resolve });
        }),
    );
    const { rt } = runtime("public", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    const first = record(rt, MEMBERS[0], "oxygen first", "concurrent-1");
    const second = record(rt, MEMBERS[1], "water second", "concurrent-2");

    const firstRequest = rules.onEvent(rt, first);
    const secondRequest = rules.onEvent(rt, second);
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(2));

    for (const item of pending) {
      item.resolve(fakeClassification(item.message, item.context));
    }
    await Promise.all([firstRequest, secondRequest]);
    expect(rt.contributionClassifications).toHaveLength(2);
  });

  it("sends Assistant A at the boundary and bounds Assistant B's classifier wait", async () => {
    vi.useFakeTimers();
    let finishClassification!: (
      value: ReturnType<typeof fakeClassification>,
    ) => void;
    let classifiedMessage!: Message;
    let classifierContext!: ClassifierContext;
    const classify = vi.fn(
      (message: Message, context: ClassifierContext) =>
        new Promise<ReturnType<typeof fakeClassification>>((resolve) => {
          classifiedMessage = message;
          classifierContext = context;
          finishClassification = resolve;
        }),
    );
    const { rt, bot } = runtime("public", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    record(rt, MEMBERS[1], "ok", "bounded-blue");
    const event = record(
      rt,
      MEMBERS[0],
      "A long contribution from Red that clearly dominates this window.",
      "bounded-red",
    );

    try {
      const classificationRequest = rules.onEvent(rt, event);
      await vi.advanceTimersByTimeAsync(0);
      expect(classify).toHaveBeenCalledTimes(1);

      const windowRequest = rules.onWindowElapsed(rt, event.ts + 1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(bot.sendTextAs).toHaveBeenCalledWith(
        "a",
        "!r",
        expect.any(String),
      );
      expect(bot.sendTextAs).not.toHaveBeenCalledWith(
        "b",
        "!r",
        expect.any(String),
      );

      await vi.advanceTimersByTimeAsync(1_999);
      expect(bot.sendTextAs).not.toHaveBeenCalledWith(
        "b",
        "!r",
        expect.any(String),
      );
      await vi.advanceTimersByTimeAsync(1);
      await windowRequest;
      expect(bot.sendTextAs).toHaveBeenCalledWith(
        "b",
        "!r",
        expect.any(String),
      );

      finishClassification(
        fakeClassification(classifiedMessage, classifierContext),
      );
      await classificationRequest;
    } finally {
      vi.useRealTimers();
    }
  });

  it("delegates to the single engine when comparison mode is off", async () => {
    const { rt, bot, event } = await makeDominantRed("public");
    const rules = new StudyBotRules();
    await rules.onEvent(rt, event);
    await rules.onWindowElapsed(rt, event.ts + 1_000);

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(bot.sendTextAs).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(1);
  });
});

describe("window evaluation records", () => {
  it("records a nudged evaluation linking the intervention", async () => {
    const { rt, event } = await makeDominantRed("public");
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

    expect(rt.windowEvaluations).toHaveLength(1);
    const evaluation = rt.windowEvaluations[0];
    expect(evaluation).toMatchObject({
      sessionId: "s",
      conditionId: "public",
      arm: "primary",
      outcome: "nudged",
      llmMode: "off",
      threshold: 0.4,
      interventionId: rt.interventions[0].id,
    });
    expect(evaluation.contributionSplit).toHaveLength(3);
    expect(evaluation.candidateTargets).toEqual([
      { userId: MEMBERS[0], identityName: "Red" },
    ]);
    expect(evaluation.maxDominanceScore).toBeCloseTo(0.66, 1);
  });

  it("baseline arm records the counterfactual with full dominance data", async () => {
    const { rt, bot, event } = await makeDominantRed("baseline");
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
    expect(rt.windowEvaluations).toHaveLength(1);
    expect(rt.windowEvaluations[0]).toMatchObject({
      outcome: "baseline-suppressed",
      interventionId: null,
    });
    expect(rt.windowEvaluations[0].contributionSplit).toHaveLength(3);
    expect(rt.windowEvaluations[0].candidateTargets).toEqual([
      { userId: MEMBERS[0], identityName: "Red" },
    ]);
  });

  it("records no-target with the split when nobody crosses the threshold", async () => {
    const { rt } = runtime("public", { contributionThreshold: 0.9 });
    record(rt, MEMBERS[0], "balanced words here", "m-red");
    const event = record(rt, MEMBERS[1], "balanced words too", "m-blue");
    await new ContributionBotRules().onWindowElapsed(rt, event.ts + 1_000);

    expect(rt.interventions).toHaveLength(0);
    expect(rt.windowEvaluations[0]).toMatchObject({ outcome: "no-target" });
    expect(rt.windowEvaluations[0].contributionSplit).toHaveLength(3);
    expect(rt.windowEvaluations[0].candidateTargets).toEqual([]);
    expect(rt.windowEvaluations[0].maxDominanceScore).not.toBeNull();
  });

  it("records warm-up and wrap-up boundaries without a split", async () => {
    const start = await makeDominantRed("public", { protectedStartMinutes: 3 });
    await new ContributionBotRules().onWindowElapsed(
      start.rt,
      start.rt.startedAtMs + 60_000,
    );
    expect(start.rt.windowEvaluations[0]).toMatchObject({
      outcome: "warm-up",
      maxDominanceScore: null,
    });
    expect(start.rt.windowEvaluations[0].contributionSplit).toEqual([]);

    const end = await makeDominantRed("public", { protectedEndMinutes: 2 });
    await new ContributionBotRules().onWindowElapsed(
      end.rt,
      end.rt.startedAtMs + 9 * 60_000,
    );
    expect(end.rt.windowEvaluations[0]).toMatchObject({ outcome: "wrap-up" });
    expect(end.rt.windowEvaluations[0].contributionSplit).toEqual([]);
  });

  it("records too-few-participants when the room has one member", async () => {
    const { rt, bot } = runtime("public");
    (bot.getJoinedMemberIds as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue([MEMBERS[0]]);
    record(rt, MEMBERS[0], "hello alone", "m-solo");
    await new ContributionBotRules().onWindowElapsed(rt, Date.now() + 120_000);

    expect(rt.windowEvaluations[0]).toMatchObject({
      outcome: "too-few-participants",
    });
    expect(rt.windowEvaluations[0].contributionSplit).toEqual([]);
  });

  it("records grace-suppressed when the only candidate is inside invite grace", async () => {
    const classify = vi.fn(
      async (message: Message, context: ClassifierContext) =>
        fakeClassification(message, context, { invitesParticipation: true }),
    );
    const { rt } = runtime("public", { llmMode: "active" });
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
    await rules.onWindowElapsed(rt, invite.ts + 1_000);

    expect(rt.interventions).toHaveLength(0);
    expect(rt.windowEvaluations[0]).toMatchObject({
      outcome: "grace-suppressed",
    });
    expect(rt.windowEvaluations[0].candidateTargets).toEqual([
      { userId: MEMBERS[0], identityName: "Red" },
    ]);
  });

  it("comparison mode records one evaluation per detection arm", async () => {
    const classify = vi.fn(async (message: Message, context: ClassifierContext) =>
      fakeClassification(message, context, { meaningfulnessScore: 1 }),
    );
    const { rt } = runtime("public", { comparisonMode: true });
    const rules = new StudyBotRules({ classify });
    record(rt, MEMBERS[1], "ok", "m-blue");
    const event = record(
      rt,
      MEMBERS[0],
      "I think oxygen matters most because without oxygen we cannot move or breathe at all on the lunar surface today.",
      "m-red",
    );
    await rules.onEvent(rt, event);
    await rules.onWindowElapsed(rt, event.ts + 1_000);

    expect(rt.windowEvaluations.map((item) => item.arm)).toEqual(["a", "b"]);
    expect(rt.windowEvaluations.map((item) => item.llmMode)).toEqual([
      "off",
      "active",
    ]);
  });

  it("indexes evaluations on the session's window grid", async () => {
    const { rt } = runtime("public");
    const rules = new ContributionBotRules();
    // Default 4-minute windows, no warm-up: boundaries at minute 4 and 8.
    await rules.onWindowElapsed(rt, rt.startedAtMs + 4 * 60_000);
    await rules.onWindowElapsed(rt, rt.startedAtMs + 8 * 60_000);

    expect(rt.windowEvaluations.map((item) => item.windowIndex)).toEqual([0, 1]);
    expect(rt.windowEvaluations[0].windowStart).toBe(
      new Date(rt.startedAtMs).toISOString(),
    );
    expect(rt.windowEvaluations[0].windowEnd).toBe(
      new Date(rt.startedAtMs + 4 * 60_000).toISOString(),
    );
  });

  it("records a classification failure instead of a classification", async () => {
    const classify = vi.fn(async (message: Message) => ({
      messageId: message.id,
      senderId: message.senderId,
      failedAt: new Date().toISOString(),
      model: "test-model",
      promptVersion: "test-v1",
      error: "boom",
    }));
    const { rt } = runtime("public", { llmMode: "active" });
    const rules = new ContributionBotRules({ classify });
    const event = record(rt, MEMBERS[0], "hello there", "m-fail");
    await rules.onEvent(rt, event);

    expect(rt.contributionClassifications).toHaveLength(0);
    expect(rt.classificationFailures).toHaveLength(1);
    expect(rt.classificationFailures[0]).toMatchObject({
      messageId: "m-fail",
      error: "boom",
    });
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
