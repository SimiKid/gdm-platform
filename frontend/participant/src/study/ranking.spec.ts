import { describe, expect, it } from "vitest";
import { insertBeforeAnchor } from "./ranking";

describe("insertBeforeAnchor", () => {
  it("moves an item down before the anchor without an off-by-one", () => {
    expect(insertBeforeAnchor(["a", "b", "c", "d"], "a", 3)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("moves an item up and appends past the end", () => {
    expect(insertBeforeAnchor(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(insertBeforeAnchor(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(insertBeforeAnchor(["a", "b"], "a", 5)).toEqual(["b", "a"]);
  });

  it("inserts a new item and ignores a drop onto itself", () => {
    expect(insertBeforeAnchor(["a", "b"], "x", 1)).toEqual(["a", "x", "b"]);
    expect(insertBeforeAnchor(["a", "b"], "b", 1)).toBeNull();
  });
});
