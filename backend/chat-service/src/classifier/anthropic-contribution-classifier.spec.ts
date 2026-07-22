import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@gdm/shared";
import { AnthropicContributionClassifier } from "./anthropic-contribution-classifier";
import type { ClassifierContext } from "./contribution-classifier";

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  vi.unstubAllGlobals();
});

const MEMBERS = ["@secret-a:localhost", "@secret-b:localhost"];

function message(id: string, senderId: string, text: string, seconds = 0): Message {
  return {
    id,
    senderId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(),
    text,
    reactions: [],
  };
}

function indicator(value: boolean, reason = "because") {
  return { value, reason };
}

describe("AnthropicContributionClassifier", () => {
  it("classifies the four indicators and derives the meaningfulness score", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "test-haiku";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              responds_to_prior: indicator(true, "agrees with Red"),
              references_task_item: indicator(true, "names oxygen"),
              has_discussion_structure: indicator(false, "no stance"),
              invites_participation: indicator(true, "asks Blue directly"),
            }),
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const context: ClassifierContext = {
      priorMessages: [
        message("m0", MEMBERS[0], "Let us start.", 0),
        message("m1", MEMBERS[0], "Oxygen should be first.", 1),
      ],
      taskItems: ["Box of matches", "Two 100-lb tanks of oxygen"],
      participantIds: MEMBERS,
    };

    const result = await new AnthropicContributionClassifier().classify(
      message("m2", MEMBERS[1], "I agree, oxygen first. What do you think?", 2),
      context,
    );

    expect(result).toMatchObject({
      messageId: "m2",
      senderId: MEMBERS[1],
      model: "test-haiku",
      promptVersion: "meaningfulness-v1",
      respondsToPrior: { value: true, reason: "agrees with Red" },
      referencesTaskItem: { value: true, reason: "names oxygen" },
      hasDiscussionStructure: { value: false, reason: "no stance" },
      invitesParticipation: { value: true, reason: "asks Blue directly" },
    });
    // invites_participation must NOT count: 2 of 3 meaningfulness indicators true.
    expect(result?.meaningfulnessScore).toBeCloseTo(2 / 3);

    expect(result?.prompt).toContain("MESSAGE TO CLASSIFY:");
    expect(result?.prompt).toContain("Sender: Blue");
    expect(result?.prompt).toContain("TASK ITEMS:");
    expect(result?.prompt).toContain("Box of matches, Two 100-lb tanks of oxygen");
    expect(result?.prompt).toContain("GROUP MEMBERS:");
    expect(result?.prompt).toContain("Red, Blue");
    expect(result?.prompt).not.toContain("@secret-a:localhost");
    expect(result?.prompt).not.toContain("@secret-b:localhost");

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(
      Object.keys(request.output_config.format.schema.properties),
    ).toEqual([
      "responds_to_prior",
      "references_task_item",
      "has_discussion_structure",
      "invites_participation",
    ]);
  });

  it("includes only the last three messages as preceding context", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              responds_to_prior: indicator(false),
              references_task_item: indicator(false),
              has_discussion_structure: indicator(false),
              invites_participation: indicator(false),
            }),
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicContributionClassifier().classify(
      message("m5", MEMBERS[1], "ok", 5),
      {
        priorMessages: [
          message("m1", MEMBERS[0], "first", 1),
          message("m2", MEMBERS[0], "second", 2),
          message("m3", MEMBERS[0], "third", 3),
          message("m4", MEMBERS[0], "fourth", 4),
        ],
        taskItems: ["Stellar map"],
        participantIds: MEMBERS,
      },
    );

    expect(result?.meaningfulnessScore).toBe(0);
    expect(result?.prompt).not.toContain("first");
    expect(result?.prompt).toContain("second");
    expect(result?.prompt).toContain("third");
    expect(result?.prompt).toContain("fourth");
  });

  it("stays silent without an API key", async () => {
    const result = await new AnthropicContributionClassifier().classify(
      message("m", "u", "hello"),
      { priorMessages: [], taskItems: [], participantIds: [] },
    );
    expect(result).toBeNull();
  });
});
