import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_INTERVENTION_CONFIG,
  GDM_RECIPIENT_KEY,
} from "@gdm/shared";
import type { Condition, InterventionMode, Message } from "@gdm/shared";
import type { MatrixBotService, TimelineEvent } from "../matrix/matrix-bot.service";
import { SessionRuntime } from "../sessions/session-runtime";
import { ContributionBotRules, NoopBotRules } from "./bot-rules";
import type { ContributionClassifier } from "../classifier/contribution-classifier";

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
      interventionWindowMinutes: 4,
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

async function makeDominantRed(
  mode: InterventionMode,
  overrides = {},
): Promise<{ rt: SessionRuntime; bot: MatrixBotService; event: TimelineEvent }> {
  const { rt, bot } = runtime(mode, overrides);
  record(rt, MEMBERS[1], "ok", "m-blue");
  const event = record(
    rt,
    MEMBERS[0],
    "I think oxygen matters most because without oxygen we cannot move.",
    "m-red",
  );
  return { rt, bot, event };
}

describe("ContributionBotRules", () => {
  it("public neutral sends one group participation split", async () => {
    const { rt, bot, event } = await makeDominantRed("public-neutral");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("@all, consider this info"),
    );
    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("Red:"),
    );
    expect(rt.interventions[0]).toMatchObject({
      mode: "public-neutral",
      audience: "public",
      tone: "neutral",
      targets: [{ userId: MEMBERS[0], identityName: "Red" }],
    });
  });

  it("public engaging names the top contributor and quieter members", async () => {
    const { rt, bot, event } = await makeDominantRed("public-engaging");
    await new ContributionBotRules().onEvent(rt, event);

    const message = (bot.sendText as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(message).toContain("@Red, you are the top contributor");
    expect(message).toContain("Green and Blue");
    expect(rt.interventions[0]).toMatchObject({
      mode: "public-engaging",
      audience: "public",
      tone: "engaging",
    });
  });

  it("private neutral sends only to the dominating member", async () => {
    const { rt, bot, event } = await makeDominantRed("private-neutral");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("@Red, consider this info"),
      expect.objectContaining({ [GDM_RECIPIENT_KEY]: MEMBERS[0] }),
    );
    expect(rt.interventions[0]).toMatchObject({
      mode: "private-neutral",
      audience: "private",
      tone: "neutral",
    });
  });

  it("private engaging sends an instruction only to the dominating member", async () => {
    const { rt, bot, event } = await makeDominantRed("private-engaging");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).toHaveBeenCalledWith(
      "!r",
      expect.stringContaining("check in with group members"),
      expect.objectContaining({ [GDM_RECIPIENT_KEY]: MEMBERS[0] }),
    );
    expect(rt.interventions[0]).toMatchObject({
      mode: "private-engaging",
      audience: "private",
      tone: "engaging",
    });
  });

  it("baseline mode never sends any intervention", async () => {
    const { rt, bot, event } = await makeDominantRed("baseline");
    await new ContributionBotRules().onEvent(rt, event);

    expect(bot.sendText).not.toHaveBeenCalled();
    expect(rt.interventions).toHaveLength(0);
  });

  it("protected start and end windows suppress nudges", async () => {
    const start = await makeDominantRed("public-neutral", {
      protectedStartMinutes: 3,
    });
    await new ContributionBotRules().onEvent(start.rt, {
      ...start.event,
      ts: start.rt.startedAtMs + 60_000,
    });
    expect(start.bot.sendText).not.toHaveBeenCalled();

    const end = await makeDominantRed("public-neutral", {
      protectedEndMinutes: 2,
    });
    await new ContributionBotRules().onEvent(end.rt, {
      ...end.event,
      ts: end.rt.startedAtMs + 9 * 60_000,
    });
    expect(end.bot.sendText).not.toHaveBeenCalled();
  });

  it("rate limits repeated interventions for the same target", async () => {
    const { rt, bot, event } = await makeDominantRed("public-neutral");
    const rules = new ContributionBotRules();
    await rules.onEvent(rt, event);

    const second = record(rt, MEMBERS[0], "Another long dominant message.", "m2");
    await rules.onEvent(rt, { ...second, ts: event.ts + 30_000 });

    expect(bot.sendText).toHaveBeenCalledTimes(1);
    expect(rt.interventions).toHaveLength(1);
  });

  it("uses the rolling contribution window for dominance checks", async () => {
    const { rt, bot } = runtime("public-neutral", {
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
      expect.stringContaining("Blue:"),
    );
    expect(rt.interventions[0].targets[0]).toMatchObject({
      userId: MEMBERS[1],
      identityName: "Blue",
    });
  });

  it("records an ignored substantive contribution in shadow mode without nudging", async () => {
    const previousMode = process.env.LLM_MODE;
    process.env.LLM_MODE = "shadow";
    const classifier: ContributionClassifier = {
      classify: vi.fn(async (message) => ({
        messageId: message.id,
        senderId: message.senderId,
        classifiedAt: new Date().toISOString(),
        substantive: true,
        relevanceWeight: 1.5,
        references: [],
        ignoredInShadow: false,
        model: "test-model",
        promptVersion: "test-v1",
        prompt: "test prompt",
        rawOutput: "{}",
        explanation: "task-relevant proposal",
      })),
    };
    const { rt, bot } = runtime("baseline", {
      ignoredGraceSeconds: 60,
      ignoredMinSubsequentMessages: 2,
    });
    const rules = new ContributionBotRules(classifier);
    const start = rt.startedAtMs;

    await rules.onEvent(rt, record(rt, MEMBERS[0], "We should rank oxygen first.", "idea", start));
    await rules.onEvent(rt, record(rt, MEMBERS[1], "What about water?", "later-1", start + 70_000));
    await rules.onEvent(rt, record(rt, MEMBERS[2], "I prefer the map.", "later-2", start + 71_000));

    expect(rt.contributionClassifications[0].ignoredInShadow).toBe(true);
    expect(rt.behavioralEvents).toContainEqual(
      expect.objectContaining({
        id: "llm-shadow:idea",
        type: "llm-shadow-trigger",
        participantId: MEMBERS[0],
      }),
    );
    expect(bot.sendText).not.toHaveBeenCalled();
    if (previousMode === undefined) delete process.env.LLM_MODE;
    else process.env.LLM_MODE = previousMode;
  });
});

describe("NoopBotRules", () => {
  it("onEvent does nothing and never throws", () => {
    const { rt } = runtime("public-neutral");
    expect(() =>
      new NoopBotRules().onEvent(rt, {} as TimelineEvent),
    ).not.toThrow();
  });
});
