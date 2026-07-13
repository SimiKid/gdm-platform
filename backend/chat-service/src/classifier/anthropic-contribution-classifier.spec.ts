import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@gdm/shared";
import { AnthropicContributionClassifier } from "./anthropic-contribution-classifier";

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  vi.unstubAllGlobals();
});

describe("AnthropicContributionClassifier", () => {
  it("uses structured output and pseudonymous participant labels", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "test-haiku";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              substantive: true,
              relevanceWeight: 3,
              references: ["m1", "not-in-context"],
              explanation: "builds on the earlier proposal",
            }),
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const previous: Message = {
      id: "m1",
      senderId: "@secret-a:localhost",
      timestamp: "2026-01-01T00:00:00.000Z",
      text: "Oxygen should be first.",
      reactions: [],
    };
    const current: Message = {
      id: "m2",
      senderId: "@secret-b:localhost",
      timestamp: "2026-01-01T00:00:01.000Z",
      text: "I agree because we cannot survive without it.",
      reactions: [],
    };

    const result = await new AnthropicContributionClassifier().classify(
      current,
      [previous],
    );

    expect(result).toMatchObject({
      messageId: "m2",
      model: "test-haiku",
      substantive: true,
      relevanceWeight: 2,
      references: ["m1"],
    });
    expect(result?.prompt).toContain("Red: Oxygen should be first.");
    expect(result?.prompt).not.toContain("@secret-a:localhost");
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.output_config.format.type).toBe("json_schema");
    expect(
      request.output_config.format.schema.properties.relevanceWeight,
    ).toEqual({ type: "number" });
  });

  it("stays silent without an API key", async () => {
    const result = await new AnthropicContributionClassifier().classify(
      {
        id: "m",
        senderId: "u",
        timestamp: "2026-01-01T00:00:00.000Z",
        text: "hello",
        reactions: [],
      },
      [],
    );
    expect(result).toBeNull();
  });
});
