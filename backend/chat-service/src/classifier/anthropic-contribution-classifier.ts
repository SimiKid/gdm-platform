import { Injectable, Logger } from "@nestjs/common";
import { buildIdentities, identityFor } from "@gdm/shared";
import type {
  ClassificationFailure,
  ClassifierIndicator,
  ClassifierRating,
  ContributionClassification,
  Message,
} from "@gdm/shared";
import type {
  ClassifierContext,
  ContributionClassifier,
} from "./contribution-classifier";

const PROMPT_VERSION = "meaningfulness-v2";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const REQUEST_TIMEOUT_MS = 10_000;
/** Preceding messages included for reference resolution (study protocol). */
const CONTEXT_MESSAGES = 3;
const MIN_RATING = 1;
const MAX_RATING = 5;

interface IndicatorOutput {
  value: boolean;
  reason: string;
}

interface RatingOutput {
  rating: number;
  reason: string;
}

/** Property order is intentional: relevance is rated before coherence. */
interface ClassificationOutput {
  relevance: RatingOutput;
  coherence: RatingOutput;
  invites_participation: IndicatorOutput;
}

const RATING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rating: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["rating", "reason"],
} as const;

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
        // A stuck external classifier must never prevent the server-side
        // session timer from checkpointing/finalizing the research record.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0,
          system:
            "You rate group-decision chat messages on two graded dimensions " +
            "(relevance, then coherence) and flag whether they invite " +
            "participation. Judge only what is present in the text — never " +
            "correctness or writing style. Do not infer identities beyond the " +
            "labels given. Return only the requested JSON.",
          messages: [{ role: "user", content: prompt }],
          output_config: {
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  relevance: RATING_SCHEMA,
                  coherence: RATING_SCHEMA,
                  invites_participation: INDICATOR_SCHEMA,
                },
                required: ["relevance", "coherence", "invites_participation"],
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
      const output = JSON.parse(rawOutput) as Partial<ClassificationOutput>;
      const relevance = toRating(output.relevance, "relevance");
      const coherence = toRating(output.coherence, "coherence");
      return {
        messageId: message.id,
        senderId: message.senderId,
        classifiedAt: new Date().toISOString(),
        relevance,
        coherence,
        invitesParticipation: toIndicator(output.invites_participation),
        meaningfulnessScore: scoreOf(relevance, coherence),
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
      "people are jointly ranking a list of items. Rate THIS message only — do not " +
      "judge correctness or writing style.",
    "",
    "Give each rating as an integer from 1 to 5 with a one-sentence justification.",
    "Answer invites_participation with true/false and a one-sentence justification.",
    "Do not infer intent beyond what is present in the text.",
    "",
    "1. relevance (1-5): How much of the message contributes content relevant to",
    "   the ranking task (naming items, stating stances, making proposals)?",
    "   5 = fully task-focused, 1 = entirely off-topic.",
    "",
    "2. coherence (1-5): How well does the message connect to and build on the",
    "   ongoing discussion? 5 = clearly addresses or extends prior messages or",
    "   members, 1 = stands alone with no connection.",
    "",
    "3. invites_participation: Does the message explicitly invite another named",
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

/**
 * Validates one graded dimension. Anything that is not an integer within
 * 1..5 throws, so the whole message lands in the failure path exactly like
 * malformed JSON — a half-usable rating must never become a silent score.
 */
function toRating(output: RatingOutput | undefined, dimension: string): ClassifierRating {
  const rating = output?.rating;
  if (
    typeof rating !== "number" ||
    !Number.isInteger(rating) ||
    rating < MIN_RATING ||
    rating > MAX_RATING
  ) {
    throw new Error(`invalid rating for ${dimension}: ${JSON.stringify(rating)}`);
  }
  return { rating, reason: String(output?.reason ?? "") };
}

function toIndicator(output: IndicatorOutput | undefined): ClassifierIndicator {
  return {
    value: output?.value === true,
    reason: String(output?.reason ?? ""),
  };
}

/** `(mean(relevance, coherence) - 1) / 4`, continuous in 0..1. */
function scoreOf(relevance: ClassifierRating, coherence: ClassifierRating): number {
  const mean = (relevance.rating + coherence.rating) / 2;
  return (mean - MIN_RATING) / (MAX_RATING - MIN_RATING);
}
