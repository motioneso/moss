import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import type { Multiplexer, MuxHandle, TmuxIo } from "@moss/ai";

import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: spawnMock
}));

function fakeChild() {
  const listeners = new Map<string, Array<(code?: number | null) => void>>();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => listeners.get("exit")?.forEach((listener) => listener()));
      return true;
    }),
    on: vi.fn((event: string, callback: (code?: number | null) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return child;
    }),
    once: vi.fn((event: string, callback: (code?: number | null) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return child;
    }),
    unref: vi.fn(),
    stdin,
    stdout,
    stderr
  };
  return child;
}

function fakeIo(files: Record<string, string> = {}): TmuxIo & { writes: Record<string, string> } {
  return {
    writes: files,
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile(path) {
      const value = this.writes[path];
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    async writeFile(path, content) {
      this.writes[path] = content;
    },
    async sleep() {}
  };
}

let currentChild: ReturnType<typeof fakeChild>;

beforeEach(() => {
  currentChild = fakeChild();
  spawnMock.mockReset();
  spawnMock.mockReturnValue(currentChild);
});

function launchLineAt(index = 0): string {
  return String(spawnMock.mock.calls[index]?.[1]?.[1] ?? "");
}

function fakeMux(): Multiplexer & { opened: string[]; killed: MuxHandle[] } {
  return {
    kind: "tmux",
    opened: [],
    killed: [],
    async open(opts) {
      this.opened.push(opts.launchLine);
      return `handle-${this.opened.length}`;
    },
    async submit() {
      throw new Error("ClaudePrintChatEngine should open per-turn commands, not paste into a REPL");
    },
    async clearComposer() {},
    async clearComposerHard() {},
    async capturePane() {
      return "";
    },
    async paste() {},
    async pressEnter() {},
    async isAlive() {
      return true;
    },
    async kill(handle) {
      this.killed.push(handle);
    },
    async interrupt() {},
    attachCommand() {
      return "tmux attach";
    }
  };
}

// ─── #2228: built-in web search for command-line models ───────────────────────────────────────
describe("ClaudePrintChatEngine — nativeSearch (#2228)", () => {
  it("switches on the CLI's WebSearch tool only when the launch asks for native search", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000003"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      nativeSearch: true
    });
    await engine.submit("what happened today");

    expect(launchLineAt()).toContain('--tools "WebSearch"');
    expect(launchLineAt()).toContain('--allowedTools "WebSearch"');
    expect(launchLineAt()).not.toContain('--tools ""');
  });

  it("keeps every tool off when native search is not requested", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000004"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("hello");

    expect(launchLineAt()).toContain('--tools ""');
    expect(launchLineAt()).not.toContain("WebSearch");
  });

  it("adds WebSearch next to the read-only vault tools when an MCP gateway is configured", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000005"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp",
      nativeSearch: true
    });
    await engine.submit("hello");

    expect(launchLineAt()).toContain('--tools "Read,Glob,Grep,WebSearch"');
    expect(launchLineAt()).toContain("mcp__jarvis__*");
    expect(launchLineAt()).toMatch(/--allowedTools '[^']*WebSearch/);
  });
});
