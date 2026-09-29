/** Parse a single RFC 6750-style bearer credential. */
export function bearerToken(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/i.exec(value.trim());
  return match?.[1];
}
