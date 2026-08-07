import { timingSafeEqual } from "node:crypto";

/** Parse a single RFC 6750-style bearer credential. */
export function bearerToken(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  return match?.[1];
}

/** Compare secrets without exposing a length-dependent string comparison. */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
