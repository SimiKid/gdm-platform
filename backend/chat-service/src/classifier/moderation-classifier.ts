import { Injectable, Logger } from "@nestjs/common";
import { anthropicModel, requestAnthropicText } from "../anthropic/anthropic-client";

const REQUEST_TIMEOUT_MS = 5_000;

interface ModerationResult {
  flagged: boolean;
  reason: string;
}

/**
 * Lightweight LLM-based moderation: checks whether a chat message contains
 * hate speech, slurs, severe insults, or other abusive language that should
 * be removed from a research study chat room. Optimised for low latency
 * (Haiku, minimal prompt, temperature 0).
 */
@Injectable()
export class ModerationClassifier {
  private readonly log = new Logger(ModerationClassifier.name);
  private warnedMissingKey = false;

  get enabled(): boolean {
    return process.env.MODERATION === "on";
  }

  async check(text: string): Promise<ModerationResult> {
    if (!this.enabled) {
      return { flagged: false, reason: "moderation-off" };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = anthropicModel();

    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.log.warn("MODERATION=on but ANTHROPIC_API_KEY missing; moderation disabled");
      }
      return { flagged: false, reason: "missing-api-key" };
    }

    try {
      const raw = await requestAnthropicText(
        apiKey,
        {
          model,
          max_tokens: 100,
          temperature: 0,
          system:
            "You are a content moderator for a university research study chat room. " +
            "Determine whether the following message contains hate speech, slurs, " +
            "severe insults, threats, or other abusive language that is inappropriate " +
            "for an academic study setting. Normal disagreement, informal language, " +
            "and mild frustration are acceptable — only flag genuinely abusive content. " +
            "Return only the requested JSON.",
          messages: [
            {
              role: "user",
              content: `Message: "${text}"\n\nIs this message abusive? Reply with {"flagged": true/false, "reason": "..."}`,
            },
          ],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  flagged: { type: "boolean" },
                  reason: { type: "string" },
                },
                required: ["flagged", "reason"],
              },
            },
          },
        },
        REQUEST_TIMEOUT_MS,
      );
      const result = JSON.parse(raw) as ModerationResult;
      return {
        flagged: result.flagged === true,
        reason: result.reason ?? "",
      };
    } catch (err) {
      this.log.warn(`moderation check failed: ${String(err)}`);
      // Fail open — don't block messages if the API is down.
      return { flagged: false, reason: `error: ${String(err).slice(0, 200)}` };
    }
  }
}
