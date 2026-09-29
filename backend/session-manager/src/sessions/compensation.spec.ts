import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectCompensationKind,
  partialPaymentPence,
  selfTerminationCompensationKind,
} from "./compensation";

const start = "2026-09-29T10:00:00.000Z";
const at = (seconds: number) => Date.parse(start) + seconds * 1_000;

describe("compensation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pays started minutes at the default rate, capped", () => {
    expect(partialPaymentPence(start, at(0))).toBe(10);
    expect(partialPaymentPence(start, at(61))).toBe(20);
    expect(partialPaymentPence(start, at(3 * 3600))).toBe(508);
  });

  it("honours configured rates and ignores unusable ones", () => {
    vi.stubEnv("PARTIAL_PAYMENT_PENCE_PER_MINUTE", "25");
    vi.stubEnv("PARTIAL_PAYMENT_MAX_PENCE", "60");
    expect(partialPaymentPence(start, at(90))).toBe(50);
    expect(partialPaymentPence(start, at(600))).toBe(60);

    vi.stubEnv("PARTIAL_PAYMENT_PENCE_PER_MINUTE", "not a number");
    vi.stubEnv("PARTIAL_PAYMENT_MAX_PENCE", "1");
    expect(partialPaymentPence(start, at(600))).toBe(10);
  });

  it("chooses the compensation kind of a disconnect by stage", () => {
    expect(disconnectCompensationKind("chat")).toBe("partial");
    expect(disconnectCompensationKind("entry")).toBe("manual_review");
    expect(disconnectCompensationKind("consent")).toBe("none");
  });

  it("reviews only withdrawals after the study proper began", () => {
    expect(selfTerminationCompensationKind("voluntary_withdrawal", "waiting")).toBe(
      "manual_review",
    );
    expect(selfTerminationCompensationKind("voluntary_withdrawal", "consent")).toBe("none");
    expect(selfTerminationCompensationKind("ineligible", "entry")).toBe("none");
  });
});
