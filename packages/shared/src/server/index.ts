/**
 * Node-only helpers shared by the backend services (`@gdm/shared/server`).
 * Never import this entry point from the frontends: it depends on node:crypto.
 */
import { timingSafeEqual } from "node:crypto";

/** Header both services use to authenticate service-to-service calls. */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Compare secrets without exposing a length-dependent string comparison. */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Check a service-to-service request against INTERNAL_API_TOKEN.
 * `"open"` means the token is unset (local dev): every request is allowed.
 */
export function checkInternalToken(
  provided: string | string[] | undefined,
): "open" | "allowed" | "denied" {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) return "open";
  return typeof provided === "string" && safeTokenEqual(provided, expected)
    ? "allowed"
    : "denied";
}

/** JSON headers for a service-to-service request, with the internal token if set. */
export function internalHeaders(): Record<string, string> {
  const token = process.env.INTERNAL_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { [INTERNAL_TOKEN_HEADER]: token } : {}),
  };
}

/** Parse an env value as a positive integer, else `fallback`. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Parse an env value as a non-negative integer, else `fallback`. */
export function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Synapse's retry hint for a 429: `Retry-After` header, else `retry_after_ms`, else 1 s. */
export async function matrixRetryAfterMs(response: Response): Promise<number> {
  const header = response.headers?.get?.("retry-after");
  const headerSeconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.max(1, Math.round(headerSeconds * 1000));
  }
  try {
    const body = (await response.clone().json()) as { retry_after_ms?: unknown };
    const value = Number(body.retry_after_ms);
    if (Number.isFinite(value) && value >= 0) return Math.max(1, Math.round(value));
  } catch {
    // Plain test doubles and malformed 429 responses fall back safely.
  }
  return 1000;
}

export interface RateLimitRetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  /** Upper bound for a single wait, including jitter. */
  maxDelayMs: number;
  /** Called before each wait (for logging). */
  onRetry?: (retryAfterMs: number, attempt: number) => void;
  /** Injectable for tests. */
  wait?: (ms: number) => Promise<void>;
}

/** Respect Synapse's retry hint on 429 responses while keeping retries and delay bounded. */
export async function fetchWithRateLimitRetry(
  request: () => Promise<Response>,
  options: RateLimitRetryOptions,
): Promise<Response> {
  const wait = options.wait ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    const response = await request();
    if (response.status !== 429 || attempt >= options.retries) return response;
    const hintedDelayMs = Math.min(options.maxDelayMs, await matrixRetryAfterMs(response));
    // Synapse gives many burst requests the same retry hint. Positive jitter
    // prevents them all waking together and immediately recreating the 429.
    const retryAfterMs = Math.min(
      options.maxDelayMs,
      hintedDelayMs + Math.floor(Math.random() * Math.min(1000, hintedDelayMs / 4)),
    );
    options.onRetry?.(retryAfterMs, attempt + 1);
    await wait(retryAfterMs);
  }
}
