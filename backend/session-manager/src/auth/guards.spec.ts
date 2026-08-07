import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { StoreService } from "../store/store.service";
import { AdminGuard } from "./admin.guard";
import { InternalGuard } from "./internal.guard";
import { ParticipantGuard } from "./participant.guard";

function context(request: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("API guards", () => {
  it("accepts the admin token only as a bearer credential", () => {
    const previous = process.env.ADMIN_API_TOKEN;
    process.env.ADMIN_API_TOKEN = "a".repeat(64);
    try {
      const guard = new AdminGuard();
      expect(
        guard.canActivate(
          context({
            headers: { authorization: `Bearer ${"a".repeat(64)}` },
            query: {},
          }),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(
          context({ headers: {}, query: { token: "a".repeat(64) } }),
        ),
      ).toThrow("Admin token required");
      expect(() =>
        guard.canActivate(
          context({
            headers: { "x-admin-token": "a".repeat(64) },
            query: {},
          }),
        ),
      ).toThrow("Admin token required");
    } finally {
      if (previous === undefined) delete process.env.ADMIN_API_TOKEN;
      else process.env.ADMIN_API_TOKEN = previous;
    }
  });

  it("compares the internal service credential without accepting arrays", () => {
    const previous = process.env.INTERNAL_API_TOKEN;
    process.env.INTERNAL_API_TOKEN = "i".repeat(64);
    try {
      const guard = new InternalGuard();
      expect(
        guard.canActivate(
          context({ headers: { "x-internal-token": "i".repeat(64) } }),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(
          context({ headers: { "x-internal-token": ["i".repeat(64)] } }),
        ),
      ).toThrow("Internal token required");
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_API_TOKEN;
      else process.env.INTERNAL_API_TOKEN = previous;
    }
  });

  it("binds participant credentials to the requested session and participant", async () => {
    const hasParticipantAccess = vi.fn(async () => true);
    const guard = new ParticipantGuard({
      hasParticipantAccess,
    } as unknown as StoreService);
    await expect(
      guard.canActivate(
        context({
          headers: { authorization: "Bearer seat-secret" },
          params: { sessionId: "session", participantId: "participant" },
          body: {},
        }),
      ),
    ).resolves.toBe(true);
    expect(hasParticipantAccess).toHaveBeenCalledWith(
      "session",
      "seat-secret",
      "participant",
    );
  });

  it("rejects absent and mismatched participant credentials identically", async () => {
    const guard = new ParticipantGuard({
      hasParticipantAccess: vi.fn(async () => false),
    } as unknown as StoreService);
    await expect(
      guard.canActivate(
        context({ headers: {}, params: { id: "session" }, body: {} }),
      ),
    ).rejects.toThrow("Participant authorization required");
    await expect(
      guard.canActivate(
        context({
          headers: { authorization: "Bearer wrong" },
          params: { id: "session" },
          body: {},
        }),
      ),
    ).rejects.toThrow("Participant authorization required");
  });
});
