/**
 * Minimal Anthropic Messages API client shared by every LLM call in the Chat
 * Service (contribution classifier, nudge generator, moderation). Callers own
 * their request body (model params, prompts, output schema) and their
 * missing-key handling; this module owns transport and response parsing.
 */

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** The model for every call: `ANTHROPIC_MODEL`, else the pinned Haiku default. */
export function anthropicModel(): string {
  return process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
}

/**
 * POST one Messages API request and return the first text block of the reply.
 * Throws on timeout, a non-ok status (with the response body) and a reply
 * without a text block, so callers keep a single failure path.
 */
export async function requestAnthropicText(
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(MESSAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Anthropic status ${res.status}: ${await res.text()}`);
  const response = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = response.content?.find((block) => block.type === "text")?.text;
  if (!text) throw new Error("Anthropic response contained no text block");
  return text;
}
