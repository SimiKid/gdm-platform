import { Injectable, Logger } from "@nestjs/common";
import { buildIdentities, identityFor } from "@gdm/shared";
import type {
  ClassificationFailure,
  ClassifierIndicator,
  ContributionClassification,
  Message,
} from "@gdm/shared";
import type {
  ClassifierContext,
  ContributionClassifier,
} from "./contribution-classifier";

const PROMPT_VERSION = "meaningfulness-v1";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
/** Preceding messages included for reference resolution (study protocol). */
const CONTEXT_MESSAGES = 3;

interface IndicatorOutput {
  value: boolean;
  reason: string;
}

interface ClassificationOutput {
  responds_to_prior: IndicatorOutput;
  references_task_item: IndicatorOutput;
  has_discussion_structure: IndicatorOutput;
  invites_participation: IndicatorOutput;
}

const INDICATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    value: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["value", "reason"],
} as const;

@Injectable()
export class AnthropicContributionClassifier implements ContributionClassifier {
  private readonly log = new Logger(AnthropicContributionClassifier.name);
  private warnedMissingKey = false;

  async classify(
    message: Message,
    context: ClassifierContext,
  ): Promise<ContributionClassification | ClassificationFailure> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
    const failure = (error: string): ClassificationFailure => ({
      messageId: message.id,
      senderId: message.senderId,
      failedAt: new Date().toISOString(),
      model,
      promptVersion: PROMPT_VERSION,
      error,
    });
    if (!apiKey) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.log.warn("ANTHROPIC_API_KEY is missing; semantic classification is silent");
      }
      return failure("missing-api-key");
    }

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
          max_tokens: 500,
          temperature: 0,
          system:
            "You classify structural features of group-decision chat messages. " +
            "Judge only what is explicitly present in the text — never quality, " +
            "correctness, or writing style. Do not infer identities beyond the " +
            "labels given. Return only the requested JSON.",
          messages: [{ role: "user", content: prompt }],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  responds_to_prior: INDICATOR_SCHEMA,
                  references_task_item: INDICATOR_SCHEMA,
                  has_discussion_structure: INDICATOR_SCHEMA,
                  invites_participation: INDICATOR_SCHEMA,
                },
                required: [
                  "responds_to_prior",
                  "references_task_item",
                  "has_discussion_structure",
                  "invites_participation",
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
      const respondsToPrior = toIndicator(output.responds_to_prior);
      const referencesTaskItem = toIndicator(output.references_task_item);
      const hasDiscussionStructure = toIndicator(output.has_discussion_structure);
      return {
        messageId: message.id,
        senderId: message.senderId,
        classifiedAt: new Date().toISOString(),
        respondsToPrior,
        referencesTaskItem,
        hasDiscussionStructure,
        invitesParticipation: toIndicator(output.invites_participation),
        meaningfulnessScore: meanOf(
          respondsToPrior,
          referencesTaskItem,
          hasDiscussionStructure,
        ),
        model,
        promptVersion: PROMPT_VERSION,
        prompt,
        rawOutput,
      };
    } catch (err) {
      this.log.warn(`semantic classification failed: ${String(err)}`);
      return failure(String(err).slice(0, 500));
    }
  }
}

function buildPrompt(message: Message, context: ClassifierContext): string {
  const identities = buildIdentities([
    ...new Set([
      ...context.participantIds,
      ...context.priorMessages.map((m) => m.senderId),
      message.senderId,
    ]),
  ]);
  const nameFor = (senderId: string) => identityFor(identities, senderId).name;
  const preceding = context.priorMessages.slice(-CONTEXT_MESSAGES);
  const precedingBlock =
    preceding.length > 0
      ? preceding.map((item) => `${nameFor(item.senderId)}: "${item.text}"`).join("\n")
      : "(no prior messages)";
  const memberNames = context.participantIds.map(nameFor).join(", ");
  const memberCount = context.participantIds.length;

  return [
    `You are analyzing a single message from a group discussion where ${memberCount} ` +
      "people are jointly ranking a list of items. Classify structural features " +
      "of THIS message only — do not judge quality, correctness, or writing style.",
    "",
    "Answer each with true/false and a one-sentence justification. Do not infer",
    "intent beyond what is explicitly present in the text.",
    "",
    "1. responds_to_prior: Does the message clearly address, react to, build on,",
    "   or directly refer to a specific prior message or group member (agreement,",
    "   disagreement, clarification, extension, or direct mention)?",
    "",
    "2. references_task_item: Does the message explicitly mention one or more",
    "   items from the ranking task list, by name?",
    "",
    "3. has_discussion_structure: Does the message contain an explicit stance,",
    '   proposal, or structured discourse move (e.g., "I disagree because...",',
    '   "let\'s put X at position Y", a counterproposal)?',
    "",
    "4. invites_participation: Does the message explicitly invite another named",
    "   or unnamed group member to contribute (a direct question to them, or an",
    '   open prompt like "anyone else?")?',
    "",
    "MESSAGE TO CLASSIFY:",
    `Sender: ${nameFor(message.senderId)}`,
    `Text: "${message.text}"`,
    "",
    "PRECEDING CONTEXT:",
    precedingBlock,
    "",
    "TASK ITEMS:",
    context.taskItems.join(", "),
    "",
    "GROUP MEMBERS:",
    memberNames,
  ].join("\n");
}

function toIndicator(output: IndicatorOutput | undefined): ClassifierIndicator {
  return {
    value: output?.value === true,
    reason: String(output?.reason ?? ""),
  };
}

function meanOf(...indicators: ClassifierIndicator[]): number {
  const trueCount = indicators.filter((item) => item.value).length;
  return trueCount / indicators.length;
}
