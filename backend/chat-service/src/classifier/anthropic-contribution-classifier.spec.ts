import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@gdm/shared";
import { AnthropicContributionClassifier } from "./anthropic-contribution-classifier";
import {
  isClassification,
  type ClassifierContext,
} from "./contribution-classifier";

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

function rating(value: unknown, reason = "because") {
  return { rating: value, reason };
}

/** Stubs fetch so the "model" returns the given JSON text verbatim. */
function stubModelOutput(text: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const EMPTY_CONTEXT: ClassifierContext = {
  priorMessages: [],
  taskItems: ["Stellar map"],
  participantIds: MEMBERS,
};

describe("AnthropicContributionClassifier", () => {
  it("rates relevance and coherence and derives the continuous meaningfulness score", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "test-haiku";
    const fetchMock = stubModelOutput(
      JSON.stringify({
        relevance: rating(5, "names oxygen and states a position"),
        coherence: rating(3, "agrees with Red without extending the argument"),
        invites_participation: indicator(true, "asks Blue directly"),
      }),
    );
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
      promptVersion: "meaningfulness-v2",
      relevance: { rating: 5, reason: "names oxygen and states a position" },
      coherence: { rating: 3, reason: "agrees with Red without extending the argument" },
      invitesParticipation: { value: true, reason: "asks Blue directly" },
    });
    // (mean(5, 3) - 1) / 4 = 0.75; invites_participation must NOT count.
    expect(result?.meaningfulnessScore).toBeCloseTo(0.75);

    expect(result?.prompt).toContain("MESSAGE TO CLASSIFY:");
    expect(result?.prompt).toContain("Sender: Blue");
    expect(result?.prompt).toContain("PRECEDING CONTEXT:");
    expect(result?.prompt).toContain("TASK ITEMS:");
    expect(result?.prompt).toContain("Box of matches, Two 100-lb tanks of oxygen");
    expect(result?.prompt).toContain("GROUP MEMBERS:");
    expect(result?.prompt).toContain("Red, Blue");
    expect(result?.prompt).not.toContain("@secret-a:localhost");
    expect(result?.prompt).not.toContain("@secret-b:localhost");
    // Ordering is intentional: relevance is asked before coherence.
    expect(result?.prompt.indexOf("1. relevance")).toBeGreaterThan(-1);
    expect(result?.prompt.indexOf("1. relevance")).toBeLessThan(
      result?.prompt.indexOf("2. coherence") ?? -1,
    );

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.temperature).toBe(0);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(
      Object.keys(request.output_config.format.schema.properties),
    ).toEqual(["relevance", "coherence", "invites_participation"]);
    expect(request.output_config.format.schema.required).toEqual([
      "relevance",
      "coherence",
      "invites_participation",
    ]);
    expect(
      request.output_config.format.schema.properties.relevance.properties.rating,
    ).toEqual({ type: "integer" });
  });

  it.each([
    [1, 1, 0],
    [5, 5, 1],
    [1, 5, 0.5],
    [2, 4, 0.5],
    [4, 3, 0.625],
  ])("maps ratings %i/%i to score %d", async (relevance, coherence, expected) => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubModelOutput(
      JSON.stringify({
        relevance: rating(relevance),
        coherence: rating(coherence),
        invites_participation: indicator(false),
      }),
    );

    const result = await new AnthropicContributionClassifier().classify(
      message("m", MEMBERS[0], "text"),
      EMPTY_CONTEXT,
    );

    expect(isClassification(result)).toBe(true);
    expect(result?.meaningfulnessScore).toBeCloseTo(expected);
  });

  it("includes only the last three messages as preceding context", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubModelOutput(
      JSON.stringify({
        relevance: rating(1),
        coherence: rating(1),
        invites_participation: indicator(false),
      }),
    );

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

  it("returns a failure record without an API key", async () => {
    const result = await new AnthropicContributionClassifier().classify(
      message("m", "u", "hello"),
      { priorMessages: [], taskItems: [], participantIds: [] },
    );
    expect(isClassification(result)).toBe(false);
    expect(result).toMatchObject({
      messageId: "m",
      senderId: "u",
      promptVersion: "meaningfulness-v2",
      error: "missing-api-key",
    });
  });

  it("returns a failure record when the API call fails", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicContributionClassifier().classify(
      message("m9", MEMBERS[0], "hello"),
      { priorMessages: [], taskItems: [], participantIds: MEMBERS },
    );

    expect(isClassification(result)).toBe(false);
    expect(result).toMatchObject({ messageId: "m9", senderId: MEMBERS[0] });
    if (!isClassification(result)) {
      expect(result.error).toContain("Anthropic status 500");
    }
  });

  it.each([
    ["out-of-range high", rating(7), rating(3), "relevance"],
    ["out-of-range low", rating(3), rating(0), "coherence"],
    ["non-integer", rating(3.5), rating(3), "relevance"],
    ["string", rating("4"), rating(3), "relevance"],
    ["missing rating", { reason: "no number" }, rating(3), "relevance"],
    ["missing dimension", rating(3), undefined, "coherence"],
  ])(
    "records a failure for a %s rating instead of a score",
    async (_label, relevance, coherence, dimension) => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      stubModelOutput(
        JSON.stringify({ relevance, coherence, invites_participation: indicator(false) }),
      );

      const result = await new AnthropicContributionClassifier().classify(
        message("m", MEMBERS[0], "text"),
        EMPTY_CONTEXT,
      );

      expect(isClassification(result)).toBe(false);
      expect(result).toMatchObject({
        messageId: "m",
        senderId: MEMBERS[0],
        promptVersion: "meaningfulness-v2",
      });
      if (!isClassification(result)) {
        expect(result.error).toContain(`invalid rating for ${dimension}`);
      }
    },
  );

  it("records a failure when the model output is not JSON", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    stubModelOutput("not json at all");

    const result = await new AnthropicContributionClassifier().classify(
      message("m", MEMBERS[0], "text"),
      EMPTY_CONTEXT,
    );

    expect(isClassification(result)).toBe(false);
    if (!isClassification(result)) {
      expect(result.error).toMatch(/JSON/);
    }
  });

  it("records a failure when the response carries no text block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ content: [] }) })),
    );

    const result = await new AnthropicContributionClassifier().classify(
      message("m", MEMBERS[0], "text"),
      EMPTY_CONTEXT,
    );

    expect(isClassification(result)).toBe(false);
    if (!isClassification(result)) {
      expect(result.error).toContain("no text block");
    }
  });
});
