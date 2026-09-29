import { describe, expect, it } from "vitest";
import { plural } from "./format";

describe("plural", () => {
  it("picks the noun form matching the count", () => {
    expect(plural(1, "msg")).toBe("1 msg");
    expect(plural(0, "msg")).toBe("0 msgs");
    expect(plural(3, "test session")).toBe("3 test sessions");
    expect(plural(2, "lobby", "lobbies")).toBe("2 lobbies");
  });
});
