import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import type { PrismaService } from "../prisma/prisma.service";

describe("HealthController", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  function build(queryRaw: () => Promise<unknown>) {
    const prisma = { $queryRaw: vi.fn(queryRaw) };
    return { ctrl: new HealthController(prisma as unknown as PrismaService), prisma };
  }

  it("liveness always answers ok without touching the database", () => {
    const { ctrl, prisma } = build(async () => [{ "?column?": 1 }]);
    expect(ctrl.health()).toEqual({ status: "ok" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("readiness reports the in-memory store when no database is configured", async () => {
    const { ctrl, prisma } = build(async () => [{ "?column?": 1 }]);
    await expect(ctrl.ready()).resolves.toEqual({ status: "ok", database: "memory" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("readiness runs a probe query against the configured database", async () => {
    process.env.DATABASE_URL = "postgres://research";
    const { ctrl, prisma } = build(async () => [{ "?column?": 1 }]);
    await expect(ctrl.ready()).resolves.toEqual({ status: "ok", database: "ok" });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("readiness answers 503 when the database cannot execute the probe", async () => {
    process.env.DATABASE_URL = "postgres://research";
    const { ctrl } = build(async () => {
      throw new Error("connection refused");
    });
    await expect(ctrl.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
