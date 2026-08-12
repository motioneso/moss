import { describe, expect, it } from "vitest";

import { parseClaudeLaunchArgs } from "./launch-args.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const MCP_TRIO = [
  "--mcp-config",
  "/tmp/mcp.json",
  "--settings",
  "/tmp/settings.json",
  "--allowedTools",
  "mcp__jarvis__* Read(/vault/**)"
];
const TAIL = ["--append-system-prompt-file", "/tmp/persona.md", "--strict-mcp-config"];

describe("parseClaudeLaunchArgs", () => {
  it("parses the bounded-engine new-session shape with the MCP trio", () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--session-id",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "hello there"
    ]);
    expect(result).toEqual({
      kind: "bounded",
      sessionFlag: { mode: "new", id: SESSION_ID },
      mcp: { configPath: "/tmp/mcp.json", allowedTools: ["mcp__jarvis__*", "Read(/vault/**)"] },
      promptText: "hello there"
    });
  });

  it("parses the resume shape and an optional --model", () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--resume",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "--model",
      "claude-sonnet-5",
      "continue"
    ]);
    expect(result).toEqual({
      kind: "bounded",
      sessionFlag: { mode: "resume", id: SESSION_ID },
      mcp: { configPath: "/tmp/mcp.json", allowedTools: ["mcp__jarvis__*", "Read(/vault/**)"] },
      promptText: "continue",
      model: "claude-sonnet-5"
    });
  });

  it('parses bare --tools "" as no-mcp', () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--session-id",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      ...TAIL,
      "hi"
    ]);
    expect(result).toEqual({ kind: "no-mcp", promptText: "hi" });
  });

  it("rejects when -p is missing", () => {
    const result = parseClaudeLaunchArgs([
      "--session-id",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "hi"
    ]);
    expect(result.kind).toBe("rejected");
  });

  it("rejects when a session flag is missing", () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "hi"
    ]);
    expect(result.kind).toBe("rejected");
  });

  it("rejects when both session flags are present", () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--session-id",
      SESSION_ID,
      "--resume",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "hi"
    ]);
    expect(result.kind).toBe("rejected");
  });

  it("rejects an unrecognized flag", () => {
    const result = parseClaudeLaunchArgs([
      "-p",
      "--session-id",
      SESSION_ID,
      "--permission-mode",
      "dontAsk",
      ...MCP_TRIO,
      ...TAIL,
      "--totally-unknown-flag",
      "hi"
    ]);
    expect(result.kind).toBe("rejected");
  });

  it("rejects the full buildStructuredCommand shape with a bounded-engine diagnostic reason", () => {
    const result = parseClaudeLaunchArgs([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--strict-mcp-config",
      "--json-schema",
      "{}",
      "--append-system-prompt-file",
      "/tmp/persona.md"
    ]);
    expect(result.kind).toBe("rejected");
    expect(result.kind === "rejected" && result.reason).toMatch(/structured/);
  });
});
