import { describe, it, expect } from "vitest";
import { buildIdentities, identityFor, isBot } from "./identity";

describe("identity", () => {
  it("isBot detects the study bot user only", () => {
    expect(isBot("@gdm_bot_abc:localhost")).toBe(true);
    expect(isBot("@gdm_x:localhost")).toBe(false);
    expect(isBot("@gdm_orchestrator_x:localhost")).toBe(false);
  });

  it("assigns colours by sorted member order and filters service accounts", () => {
    const ids = buildIdentities([
      "@gdm_c:localhost",
      "@gdm_a:localhost",
      "@gdm_orchestrator_x:localhost",
      "@gdm_bot_y:localhost",
    ]);
    expect(ids.size).toBe(2); // orchestrator + bot filtered out
    expect(ids.get("@gdm_a:localhost")?.name).toBe("Red");
    expect(ids.get("@gdm_c:localhost")?.name).toBe("Blue");
  });

  it("identityFor falls back to Gray for unknown users", () => {
    expect(identityFor(new Map(), "@x:localhost").name).toBe("Gray");
  });
});
