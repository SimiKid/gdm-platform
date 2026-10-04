import { Logger, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { InternalGuard } from "./internal.guard";

function context(headers: Record<string, string | string[]>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe("InternalGuard", () => {
  it("accepts only the exact scalar service credential", () => {
    const previous = process.env.INTERNAL_API_TOKEN;
    process.env.INTERNAL_API_TOKEN = "i".repeat(64);
    try {
      const guard = new InternalGuard();
      expect(
        guard.canActivate(
          context({ "x-internal-token": "i".repeat(64) }),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(context({ "x-internal-token": "wrong" })),
      ).toThrow("Internal token required");
      expect(() =>
        guard.canActivate(
          context({ "x-internal-token": ["i".repeat(64)] }),
        ),
      ).toThrow("Internal token required");
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_API_TOKEN;
      else process.env.INTERNAL_API_TOKEN = previous;
    }
  });

  it("stays open without a configured token and warns only once", () => {
    const previous = process.env.INTERNAL_API_TOKEN;
    delete process.env.INTERNAL_API_TOKEN;
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const guard = new InternalGuard();
      expect(guard.canActivate(context({}))).toBe(true);
      expect(guard.canActivate(context({ "x-internal-token": "anything" }))).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      if (previous !== undefined) process.env.INTERNAL_API_TOKEN = previous;
    }
  });
});
