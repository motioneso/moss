import { describe, expect, it } from "vitest";

import { isSameOriginAppPath, sameOriginAppPathOrNull } from "@moss/notifications";

// #743 security finding 4: the one rule every layer uses for a notification's click link.
describe("isSameOriginAppPath", () => {
  it.each([
    "/",
    "/notifications",
    "/tasks/1",
    "/tasks/1?tab=notes#top",
    "/search?q=a%20b",
    "/modules/food/recipes/42"
  ])("accepts %s", (href) => {
    expect(isSameOriginAppPath(href)).toBe(true);
    expect(sameOriginAppPathOrNull(href)).toBe(href);
  });

  it.each([
    ["absolute URL", "https://evil.example.com/x"],
    ["protocol-relative", "//evil.example.com/x"],
    ["backslash after slash", "/\\evil.example.com/x"],
    ["double backslash", "/\\\\evil.example.com"],
    ["backslash inside the path", "/tasks\\..\\x"],
    ["scheme", "javascript:alert(1)"],
    ["colon anywhere", "/tasks:1"],
    ["newline", "/tasks/1\n"],
    ["tab", "/\t/evil.example.com"],
    ["carriage return", "/tasks\r/1"],
    ["null byte", "/tasks\u0000 1"],
    ["delete char", "/tasks\u007f"],
    ["relative path", "tasks/1"],
    ["empty", ""],
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined]
  ])("refuses %s", (_label, href) => {
    expect(isSameOriginAppPath(href)).toBe(false);
    expect(sameOriginAppPathOrNull(href)).toBeNull();
  });
});
