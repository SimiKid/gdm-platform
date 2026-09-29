import type { Prisma } from "@prisma/client";

/** Parse an ISO timestamp for a DB column; an unparsable value becomes now. */
export function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function toOptionalDate(value: string | undefined): Date | undefined {
  return value ? toDate(value) : undefined;
}

/** A domain value stored as-is in a JSON column. */
export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** A JSON column read back as the domain type it was written from. */
export function fromJson<T>(value: Prisma.JsonValue): T {
  return value as unknown as T;
}
