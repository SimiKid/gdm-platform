import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicNudgeMessageGenerator } from "./anthropic-nudge-message-generator";

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_MODEL;
  vi.unstubAllGlobals();
});

function response(message: string) {
  return {
    ok: true,
    json: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ message }),
        },
      ],
    }),
  };
}

describe("AnthropicNudgeMessageGenerator", () => {
  it("generates a fresh nudge with the exact target and percentage", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_MODEL = "test-haiku";
    const fetchMock = vi.fn(async () =>
      response(
        "Great energy, @Red — you've contributed 66% so far! How about inviting another voice into the next step?",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicNudgeMessageGenerator().generate({
      targetName: "Red",
      contributionPercent: 66,
      otherParticipantNames: ["Blue", "Green"],
      previousMessages: [
        "@Red, you've brought a lot of energy to this — 66% so far!",
      ],
    });

    expect(result).toBe(
      "Great energy, @Red — you've contributed 66% so far! How about inviting another voice into the next step?",
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request).toMatchObject({
      model: "test-haiku",
      temperature: 0.9,
      output_config: { format: { type: "json_schema" } },
    });
    expect(request.messages[0].content).toContain("@Red exactly once");
    expect(request.messages[0].content).toContain("66% exactly once");
    expect(request.messages[0].content).toContain("must not be repeated");
  });

  it("retries when the model repeats a previous nudge", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const previous =
      "Nice momentum, @Blue — you're at 58% so far. Could you bring another voice in?";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(previous))
      .mockResolvedValueOnce(
        response(
          "Thanks for keeping things moving, @Blue — you've contributed 58%. Want to pass the next question to someone else?",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicNudgeMessageGenerator().generate({
      targetName: "Blue",
      contributionPercent: 58,
      otherParticipantNames: ["Red", "Green"],
      previousMessages: [previous],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toContain("Thanks for keeping things moving");
    const retry = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(retry.messages[0].content).toContain("substantially different");
  });

  it("rejects output that exposes another participant or percentage", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      response(
        "@Red, you are at 66%. Please let Blue speak next.",
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AnthropicNudgeMessageGenerator().generate({
      targetName: "Red",
      contributionPercent: 66,
      otherParticipantNames: ["Blue", "Green"],
      previousMessages: [],
    });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null without an API key so the rule engine can use its fallback", async () => {
    const result = await new AnthropicNudgeMessageGenerator().generate({
      targetName: "Red",
      contributionPercent: 66,
      otherParticipantNames: ["Blue", "Green"],
      previousMessages: [],
    });

    expect(result).toBeNull();
  });
});
