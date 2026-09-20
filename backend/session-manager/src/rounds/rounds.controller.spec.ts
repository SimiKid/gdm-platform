import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { RoundsController } from "./rounds.controller";
import type { SessionsService } from "../sessions/sessions.service";
import type { StoreService } from "../store/store.service";

const rounds = [
  {
    number: 1,
    label: "pilot",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-02-01T00:00:00.000Z",
    sessionCount: 4,
    completedCount: 3,
  },
  {
    number: 2,
    label: "",
    startedAt: "2026-02-01T00:00:00.000Z",
    sessionCount: 1,
    completedCount: 0,
  },
];

function build() {
  const store = {
    currentRound: vi.fn(async () => ({
      id: 2,
      label: "",
      startedAt: "2026-02-01T00:00:00.000Z",
    })),
    listRounds: vi.fn(async () => rounds),
    updateRoundLabel: vi.fn(async (id: number, label: string) =>
      rounds.some((round) => round.number === id)
        ? { id, label, startedAt: "2026-01-01T00:00:00.000Z" }
        : undefined,
    ),
  };
  const sessions = {
    startRound: vi.fn(async (label: string) => ({
      round: { ...rounds[1], number: 3, label },
      abortedWaitingSessions: 1,
    })),
  };
  const ctrl = new RoundsController(
    sessions as unknown as SessionsService,
    store as unknown as StoreService,
  );
  return { ctrl, store, sessions };
}

describe("RoundsController", () => {
  it("lists every round together with the currently open one", async () => {
    const { ctrl } = build();
    await expect(ctrl.list()).resolves.toEqual({ currentRound: 2, rounds });
  });

  it("starts the next round with a trimmed label (empty when omitted)", async () => {
    const { ctrl, sessions } = build();
    await expect(ctrl.start({ label: "  threshold 35%  " })).resolves.toMatchObject({
      round: { number: 3, label: "threshold 35%" },
      abortedWaitingSessions: 1,
    });
    expect(sessions.startRound).toHaveBeenCalledWith("threshold 35%");

    await ctrl.start(undefined as never);
    expect(sessions.startRound).toHaveBeenLastCalledWith("");
  });

  it("rejects labels above the 120 character bound before touching the service", () => {
    const { ctrl, sessions } = build();
    expect(() => ctrl.start({ label: "x".repeat(121) })).toThrow();
    expect(sessions.startRound).not.toHaveBeenCalled();
  });

  it("renames a round and returns its enriched summary row", async () => {
    const { ctrl, store } = build();
    await expect(ctrl.rename("1", { label: " renamed " })).resolves.toEqual(rounds[0]);
    expect(store.updateRoundLabel).toHaveBeenCalledWith(1, "renamed");
  });

  it("falls back to a bare row when the renamed round has no summary yet", async () => {
    const { ctrl, store } = build();
    store.updateRoundLabel.mockResolvedValueOnce({
      id: 7,
      label: "new",
      startedAt: "2026-03-01T00:00:00.000Z",
    });
    await expect(ctrl.rename("7", { label: "new" })).resolves.toEqual({
      number: 7,
      label: "new",
      startedAt: "2026-03-01T00:00:00.000Z",
      endedAt: undefined,
      sessionCount: 0,
      completedCount: 0,
    });
  });

  it("returns 404 for a non-numeric or unknown round number", async () => {
    const { ctrl, store } = build();
    await expect(ctrl.rename("abc", { label: "x" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(store.updateRoundLabel).not.toHaveBeenCalled();
    await expect(ctrl.rename("99", { label: "x" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(store.updateRoundLabel).toHaveBeenCalledWith(99, "x");
  });
});
