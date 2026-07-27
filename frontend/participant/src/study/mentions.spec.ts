import { describe, it, expect } from "vitest";
import { detectMention, splitMentions } from "./mentions";

describe("detectMention", () => {
  it("opens on an '@' at the start or after whitespace", () => {
    expect(detectMention("@Bl", 3)).toEqual({ start: 0, query: "Bl" });
    expect(detectMention("hi @Bl", 6)).toEqual({ start: 3, query: "Bl" });
  });

  it("reports the bare '@' with an empty query", () => {
    expect(detectMention("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("closes once whitespace follows the mention", () => {
    expect(detectMention("hey @Blue ", 10)).toBeNull();
  });

  it("ignores an '@' glued to a previous word (e.g. emails)", () => {
    expect(detectMention("me@Blue", 7)).toBeNull();
  });

  it("uses the caret, not the end of the string", () => {
    expect(detectMention("@Blue and more", 3)).toEqual({ start: 0, query: "Bl" });
  });
});

describe("splitMentions", () => {
  const names = ["Blue", "Red", "Magenta"];

  it("highlights only known participant names", () => {
    expect(splitMentions("hey @Blue and @Nobody", names)).toEqual([
      { type: "text", value: "hey " },
      { type: "mention", value: "@Blue" },
      { type: "text", value: " and @Nobody" },
    ]);
  });

  it("leaves the body untouched when there are no mentions", () => {
    expect(splitMentions("just talking", names)).toEqual([
      { type: "text", value: "just talking" },
    ]);
  });

  it("does not treat an email-like '@name' as a mention", () => {
    expect(splitMentions("a@Blue.com", names)).toEqual([
      { type: "text", value: "a@Blue.com" },
    ]);
  });

  it("matches a mention at the very start and end of the body", () => {
    expect(splitMentions("@Red hi @Blue", names)).toEqual([
      { type: "mention", value: "@Red" },
      { type: "text", value: " hi " },
      { type: "mention", value: "@Blue" },
    ]);
  });

  it("returns the plain body when no names are known", () => {
    expect(splitMentions("@Blue", [])).toEqual([
      { type: "text", value: "@Blue" },
    ]);
  });
});
