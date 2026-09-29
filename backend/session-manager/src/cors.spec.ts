import { describe, expect, it } from "vitest";
import { corsOrigins } from "./cors";

describe("corsOrigins", () => {
  it("falls back to the local frontends when unset, empty or blank", () => {
    for (const value of [undefined, "", "   "]) {
      expect(corsOrigins(value)).toContain("http://localhost:5173");
    }
  });

  it("parses a comma-separated allowlist", () => {
    expect(corsOrigins(" https://a.example , ,https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });
});
