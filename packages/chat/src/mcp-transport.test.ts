import { describe, expect, it } from "vitest";

import { filterToolsForSession } from "./mcp-transport.js";

const TOOLS = [
  { name: "workshop.runCommand" },
  { name: "workshop.buildModule" },
  { name: "chat.summarize" }
];

describe("filterToolsForSession", () => {
  it("hands over exactly the token's captured allowlist", () => {
    expect(filterToolsForSession(TOOLS, new Set(["workshop.runCommand"]))).toEqual([
      { name: "workshop.runCommand" }
    ]);
  });

  it("hands over everything for the old unrestricted tokens", () => {
    expect(filterToolsForSession(TOOLS, null)).toEqual(TOOLS);
  });

  it("hands over nothing the token does not permit", () => {
    expect(filterToolsForSession(TOOLS, new Set(["chat.summarize"]))).toEqual([
      { name: "chat.summarize" }
    ]);
    expect(filterToolsForSession(TOOLS, new Set())).toEqual([]);
  });
});
