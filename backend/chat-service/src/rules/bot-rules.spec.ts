import { describe, it, expect } from "vitest";
import { NoopBotRules } from "./bot-rules";
import type { SessionRuntime } from "../sessions/session-runtime";
import type { TimelineEvent } from "../matrix/matrix-bot.service";

describe("NoopBotRules", () => {
  it("onEvent does nothing and never throws", () => {
    const rules = new NoopBotRules();
    expect(() =>
      rules.onEvent({} as SessionRuntime, {} as TimelineEvent),
    ).not.toThrow();
  });
});
