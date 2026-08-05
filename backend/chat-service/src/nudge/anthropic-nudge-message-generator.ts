import { Injectable, Logger } from "@nestjs/common";
import type {
  NudgeMessageContext,
  NudgeMessageGenerator,
} from "./nudge-message-generator";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_PREVIOUS_MESSAGES = 8;
const MAX_ATTEMPTS = 2;

interface NudgeOutput {
  message?: unknown;
}

@Injectable()
export class AnthropicNudgeMessageGenerator implements NudgeMessageGenerator {
  private readonly log = new Logger(AnthropicNudgeMessageGenerator.name);
  private warnedMissingKey = false;

  async generate(context: NudgeMessageContext): Promise<string | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.log.warn(
          "ANTHROPIC_API_KEY is missing; using the fixed nudge fallback",
        );
      }
      return null;
    }

    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            model,
            max_tokens: 120,
            temperature: 0.9,
            system:
              "You write short facilitation nudges for a group decision-making chat. " +
              "Be warm, natural, friendly, and encouraging, never judgmental or shaming. " +
              "Do not mention AI, moderation, rules, scores, or hidden participant data. " +
              "Return only the requested JSON.",
            messages: [
              {
                role: "user",
                content: buildPrompt(context, attempt),
              },
            ],
            output_config: {
              format: {
                type: "json_schema",
                schema: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    message: { type: "string" },
                  },
                  required: ["message"],
                },
              },
            },
          }),
        });
        if (!res.ok) {
          throw new Error(`Anthropic status ${res.status}: ${await res.text()}`);
        }
        const response = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const rawOutput = response.content?.find(
          (block) => block.type === "text",
        )?.text;
        if (!rawOutput) {
          throw new Error("Anthropic response contained no text block");
        }
        const output = JSON.parse(rawOutput) as NudgeOutput;
        const candidate = normalizeMessage(output.message);
        if (candidate && isSafeCandidate(candidate, context)) return candidate;

        this.log.warn(
          `generated nudge failed validation (attempt ${attempt}/${MAX_ATTEMPTS})`,
        );
      } catch (err) {
        this.log.warn(
          `nudge generation failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${String(err)}`,
        );
      }
    }
    return null;
  }
}

function buildPrompt(context: NudgeMessageContext, attempt: number): string {
  const prior = context.previousMessages.slice(-MAX_PREVIOUS_MESSAGES);
  return [
    "Write one new nudge that follows every rule below:",
    `- Address @${context.targetName} exactly once.`,
    `- Include the exact contribution percentage ${context.contributionPercent}% exactly once.`,
    "- Positively acknowledge that person's participation.",
    "- Gently invite them to make space for or draw in other group members.",
    "- Use one or two short sentences and no more than 45 words.",
    "- Do not name, mention, or reveal a percentage for anyone else.",
    context.otherParticipantNames.length > 0
      ? `- In particular, do not use these other participant labels: ${context.otherParticipantNames.join(", ")}.`
      : "",
    "- Use fresh wording rather than a stock or repeated phrase.",
    attempt > 1
      ? "- The previous candidate was unusable; make this version substantially different."
      : "",
    "",
    "Recent bot nudges that must not be repeated:",
    prior.length > 0 ? JSON.stringify(prior) : "(none)",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function isSafeCandidate(
  candidate: string,
  context: NudgeMessageContext,
): boolean {
  if (candidate.length > 320 || candidate.split(/\s+/).length > 45) return false;
  const expectedMention = `@${context.targetName}`;
  if (countOccurrences(candidate, expectedMention) !== 1) return false;

  const mentions = candidate.match(/@[\p{L}\p{N}_-]+/gu) ?? [];
  if (mentions.some((mention) => mention !== expectedMention)) return false;
  if (
    context.otherParticipantNames.some((name) =>
      containsIdentityName(candidate, name),
    )
  ) {
    return false;
  }

  const percentages = candidate.match(/\b\d{1,3}%/g) ?? [];
  if (
    percentages.length !== 1 ||
    percentages[0] !== `${context.contributionPercent}%`
  ) {
    return false;
  }

  return !context.previousMessages.some(
    (previous) => normalizeMessage(previous) === candidate,
  );
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

function containsIdentityName(value: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`,
    "iu",
  ).test(value);
}
