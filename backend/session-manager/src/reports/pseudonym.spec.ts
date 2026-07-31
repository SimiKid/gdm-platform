import { describe, expect, it } from "vitest";
import type { Session } from "@gdm/shared";
import { botKindLabel, pseudonymize, senderPseudonym } from "./pseudonym";

const session = {
  participants: [
    {
      id: "participant-uuid-1",
      name: "P1",
      trackingToken: "PROLIFIC-1",
      matrixUserId: "@gdm_u1:localhost",
    },
  ],
} as unknown as Session;

describe("pseudonymize", () => {
  it("is deterministic and formatted as prefix + 8 hex chars", () => {
    const first = pseudonymize("P", "participant-uuid-1");
    expect(first).toMatch(/^P-[0-9a-f]{8}$/);
    expect(pseudonymize("P", "participant-uuid-1")).toBe(first);
    expect(pseudonymize("S", "participant-uuid-1")).toMatch(/^S-[0-9a-f]{8}$/);
  });

  it("gives distinct ids distinct pseudonyms", () => {
    expect(pseudonymize("P", "a")).not.toBe(pseudonymize("P", "b"));
  });
});

describe("senderPseudonym", () => {
  it("resolves a participant by internal id or Matrix id to the same pseudonym", () => {
    const byId = senderPseudonym(session, "participant-uuid-1");
    const byMatrix = senderPseudonym(session, "@gdm_u1:localhost");
    expect(byId).toBe(byMatrix);
    expect(byId).toBe(pseudonymize("P", "participant-uuid-1"));
  });

  it("labels bot senders without hashing them", () => {
    expect(senderPseudonym(session, "@gdm_bot:localhost")).toBe("BOT");
    expect(senderPseudonym(session, "@gdm_bot_a_x:localhost")).toBe("BOT-A");
    expect(senderPseudonym(session, "@gdm_bot_b_x:localhost")).toBe("BOT-B");
  });

  it("hashes unknown senders instead of leaking the raw id", () => {
    const result = senderPseudonym(session, "@stranger:localhost");
    expect(result).toMatch(/^P-[0-9a-f]{8}$/);
    expect(result).not.toContain("stranger");
  });
});

describe("botKindLabel", () => {
  it("distinguishes the comparison arms", () => {
    expect(botKindLabel("@gdm_bot:x")).toBe("BOT");
    expect(botKindLabel("@gdm_bot_a_1:x")).toBe("BOT-A");
    expect(botKindLabel("@gdm_bot_b_1:x")).toBe("BOT-B");
  });
});
