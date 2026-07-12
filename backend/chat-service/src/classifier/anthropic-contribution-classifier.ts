import { Injectable, Logger } from "@nestjs/common";
import { buildIdentities, identityFor } from "@gdm/shared";
import type { ContributionClassification, Message } from "@gdm/shared";
import type { ContributionClassifier } from "./contribution-classifier";

const PROMPT_VERSION = "ignored-contribution-v1";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

interface ClassificationOutput {
  substantive: boolean;
  relevanceWeight: number;
  references: string[];
  explanation: string;
}

@Injectable()
export class AnthropicContributionClassifier implements ContributionClassifier {
  private readonly log = new Logger(AnthropicContributionClassifier.name);
  private warnedMissingKey = false;

  async classify(
    message: Message,
    context: Message[],
  ): Promise<ContributionClassification | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.log.warn("ANTHROPIC_API_KEY is missing; semantic shadow mode is silent");
      }
      return null;
    }

    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const prompt = buildPrompt(message, context);
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
          max_tokens: 300,
          temperature: 0,
          system:
            "You classify group-decision chat messages. Return only the requested JSON. " +
            "Disagreement counts as engagement. Do not infer identities beyond the labels given.",
          messages: [{ role: "user", content: prompt }],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  substantive: { type: "boolean" },
                  relevanceWeight: { type: "number", minimum: 0, maximum: 2 },
                  references: { type: "array", items: { type: "string" } },
                  explanation: { type: "string" },
                },
                required: [
                  "substantive",
                  "relevanceWeight",
                  "references",
                  "explanation",
                ],
              },
            },
          },
        }),
      });
      if (!res.ok) throw new Error(`Anthropic status ${res.status}: ${await res.text()}`);
      const response = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const rawOutput = response.content?.find((block) => block.type === "text")?.text;
      if (!rawOutput) throw new Error("Anthropic response contained no text block");
      const output = JSON.parse(rawOutput) as ClassificationOutput;
      const allowedIds = new Set(context.map((item) => item.id));
      return {
        messageId: message.id,
        senderId: message.senderId,
        classifiedAt: new Date().toISOString(),
        substantive: output.substantive,
        relevanceWeight: clamp(output.relevanceWeight, 0, 2),
        references: output.references.filter((id) => allowedIds.has(id)),
        ignoredInShadow: false,
        model,
        promptVersion: PROMPT_VERSION,
        prompt,
        rawOutput,
        explanation: output.explanation,
      };
    } catch (err) {
      this.log.warn(`semantic classification failed: ${String(err)}`);
      return null;
    }
  }
}

function buildPrompt(message: Message, context: Message[]): string {
  const messages = [...context, message].slice(-21);
  const identities = buildIdentities(messages.map((item) => item.senderId));
  const transcript = messages
    .map(
      (item) =>
        `[${item.id}] ${identityFor(identities, item.senderId).name}: ${item.text}`,
    )
    .join("\n");
  return [
    "Classify the final message in this transcript.",
    "substantive: it adds a proposal, reason, task fact, question, disagreement, or decision-relevant idea.",
    "relevanceWeight: 0 for noise/empty agreement, 1 for normal task content, up to 2 for a strong concrete contribution.",
    "references: IDs of earlier messages the final message acknowledges, answers, disputes, or develops.",
    "Transcript (participants are pseudonymous):",
    transcript,
  ].join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
}
