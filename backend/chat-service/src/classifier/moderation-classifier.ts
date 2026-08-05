import { Injectable, Logger } from "@nestjs/common";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface ModerationResult {
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
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;

    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.log.warn("MODERATION=on but ANTHROPIC_API_KEY missing; moderation disabled");
      }
      return { flagged: false, reason: "missing-api-key" };
    }

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
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
        }),
      });

      if (!res.ok) throw new Error(`Anthropic status ${res.status}`);
      const response = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const raw = response.content?.find((b) => b.type === "text")?.text;
      if (!raw) throw new Error("no text block in response");
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
