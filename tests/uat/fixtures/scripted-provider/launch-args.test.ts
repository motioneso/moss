import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import type { TmuxIo } from "@moss/ai";

import { parseClaudeLaunchArgs } from "./launch-args.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: spawnMock
}));

function fakeChild() {
  const listeners = new Map<string, Array<() => void>>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => listeners.get("exit")?.forEach((listener) => listener()));
      return true;
    }),
    on: vi.fn((event: string, callback: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    }),
    once: vi.fn((event: string, callback: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
    }),
    unref: vi.fn(),
    stdin,
    stdout,
    stderr
  };
}

function fakeIo(): TmuxIo {
  const writes: Record<string, string> = {};
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile(path) {
      const value = writes[path];
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async writeFile(path, content) {
      writes[path] = content;
    },
    async sleep() {}
  };
}

/**
 * Splits a shell command line into argv tokens, treating single- and
 * double-quoted spans as atomic. Only handles the plain quoting this fixture's
 * inputs produce (no apostrophes inside quoted values) — not a general shell parser.
 */
function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

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

describe("parseClaudeLaunchArgs against the real read-only launch line", () => {
  let currentChild: ReturnType<typeof fakeChild>;

  beforeEach(() => {
    currentChild = fakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(currentChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses the line ClaudePrintChatEngine actually spawns as bounded, with MCP present", async () => {
    const { ClaudePrintChatEngine } =
      await import("../../../../packages/chat/src/live/claude-print-chat-engine.js");
    const io = fakeIo();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      homeBase: "/home/test",
      sessionId: "22222222-2222-2222-2222-222222222222"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.submit("hello");

    const launchLine = String(spawnMock.mock.calls[0]?.[1]?.[1] ?? "");
    expect(launchLine).toContain("claude -p");

    const allTokens = tokenizeShellLine(launchLine);
    const claudeIndex = allTokens.indexOf("claude");
    const argv = allTokens.slice(claudeIndex + 1);
    const result = parseClaudeLaunchArgs(argv);

    expect(result.kind).toBe("bounded");
    expect(result.kind === "bounded" && result.mcp).toBeDefined();
  });
});
