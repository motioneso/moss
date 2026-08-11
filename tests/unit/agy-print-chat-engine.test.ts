import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgyPrintChatEngine } from "../../packages/chat/src/live/agy-print-chat-engine.js";
import { AGY_SESSION_LOG_FILENAME } from "../../packages/chat/src/live/private-transcript-cleanup.js";
import { createRealEngineFactory } from "../../packages/chat/src/live/runtime.js";
import type { Multiplexer, MuxHandle, TmuxIo } from "@moss/ai";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: spawnMock
}));

function fakeChild() {
  const child = {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    on: vi.fn(),
    unref: vi.fn()
  };
  child.on.mockReturnValue(child);
  return child;
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

function fakeIo(
  files: Record<string, string> = {}
): TmuxIo & { runs: string[]; writes: Record<string, string> } {
  return {
    runs: [],
    writes: files,
    async run(cmd, args) {
      this.runs.push([cmd, ...args].join(" "));
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

function fakeMux(): Multiplexer & { opened: string[]; killed: MuxHandle[] } {
  return {
    kind: "tmux",
    opened: [],
    killed: [],
    async open(opts) {
      this.opened.push(opts.launchLine);
      return "handle-1";
    },
    async submit() {
      throw new Error("AgyPrintChatEngine should open per-turn commands, not paste into a REPL");
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

describe("AgyPrintChatEngine", () => {
  it("runs submitted turns through agy print mode with permission skipping", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new AgyPrintChatEngine("user-1", io, { mux, homeBase: "/home/test" });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("read ./word.txt");

    expect(launchLineAt()).toContain("agy --dangerously-skip-permissions --print");
    expect(launchLineAt()).toContain("cd '/tmp/jarvis-neutral'");
    expect(launchLineAt()).toContain(
      `--log-file '/tmp/jarvis-neutral/${AGY_SESSION_LOG_FILENAME}'`
    );
    expect(mux.opened).toEqual([]);
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("agy --dangerously-skip-permissions --print")],
      expect.objectContaining({
        cwd: "/tmp/jarvis-neutral",
        detached: true,
        stdio: "ignore"
      })
    );
    expect(await engine.isAlive()).toBe(true);
    await engine.interrupt();
    expect(currentChild.kill).toHaveBeenCalledWith("SIGINT");
    await engine.kill();
    expect(currentChild.kill).toHaveBeenCalledWith();
    expect(await engine.isAlive()).toBe(false);
  });

  it("reads Antigravity print transcripts through parseTranscript", async () => {
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    const transcript =
      JSON.stringify({ type: "VIEW_FILE", path: "./word.txt" }) +
      "\n" +
      JSON.stringify({ type: "PLANNER_RESPONSE", content: "alpha-bravo-charlie" }) +
      "\n";
    const path = `/home/test/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript_full.jsonl`;
    const io = fakeIo({
      [path]: transcript,
      [`/tmp/jarvis-neutral/${AGY_SESSION_LOG_FILENAME}`]: `Created conversation ${uuid}\n`
    });
    const mux = fakeMux();
    const engine = new AgyPrintChatEngine("user-1", io, { mux, homeBase: "/home/test" });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });

    const result = await engine.readNew(0);

    expect(result.records.map((r) => r.kind)).toEqual(["tool", "reply"]);
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(transcript.length);
    expect(io.runs.some((run) => run.startsWith("find "))).toBe(false);
  });

  it("captures at spawn and continues without waiting for readNew", async () => {
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    const path = `/home/test/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript_full.jsonl`;
    const io = fakeIo({
      [path]: `${JSON.stringify({ type: "PLANNER_RESPONSE", content: "first" })}\n`,
      [`/tmp/jarvis-neutral/${AGY_SESSION_LOG_FILENAME}`]: `Created conversation ${uuid}\n`
    });
    const mux = fakeMux();
    const engine = new AgyPrintChatEngine("user-1", io, { mux, homeBase: "/home/test" });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md"
    });

    await engine.submit("first");
    await engine.submit("second");

    expect(launchLineAt(1)).toContain(`--conversation ${uuid}`);
    expect(launchLineAt(1)).not.toContain("--continue");
  });

  it("hard-stops continuation when exact identity was not captured", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new AgyPrintChatEngine("user-1", io, { mux, homeBase: "/home/test" });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md"
    });

    await engine.submit("first");

    await expect(engine.submit("second")).rejects.toThrow("identity unavailable");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(launchLineAt()).not.toContain("--continue");
  });

  it("purges only its captured brain directory before graceful kill", async () => {
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    const path = `/home/test/.gemini/antigravity-cli/brain/${uuid}/.system_generated/logs/transcript_full.jsonl`;
    const io = fakeIo({
      [path]: `${JSON.stringify({ type: "PLANNER_RESPONSE", content: "done" })}\n`,
      [`/tmp/jarvis-neutral/${AGY_SESSION_LOG_FILENAME}`]: `Created conversation ${uuid}\n`
    });
    const mux = fakeMux();
    const engine = new AgyPrintChatEngine("user-1", io, { mux, homeBase: "/home/test" });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md"
    });
    await engine.submit("go");
    await engine.readNew(0);

    await engine.purgeTranscripts();
    await engine.kill();

    expect(io.runs).toContain(`rm -rf /home/test/.gemini/antigravity-cli/brain/${uuid}`);
    expect(io.runs).not.toContain("rm -rf /home/test/.gemini/antigravity-cli/brain");
  });

  it("fails closed when the exact AGY directory cannot be removed", async () => {
    const uuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
    const io = fakeIo({
      [`/tmp/jarvis-neutral/${AGY_SESSION_LOG_FILENAME}`]: `Created conversation ${uuid}\n`
    });
    const engine = new AgyPrintChatEngine("user-1", io, {
      mux: fakeMux(),
      homeBase: "/home/test"
    });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md"
    });
    await engine.readNew(0);
    io.run = async (cmd, args) => {
      io.runs.push([cmd, ...args].join(" "));
      return { code: cmd === "rm" ? 1 : 0, stdout: "" };
    };

    await expect(engine.purgeTranscripts()).rejects.toThrow("purge AGY");
  });
});

describe("AgyPrintChatEngine Runtime Routing", () => {
  it("routes google non_interactive to AgyPrintChatEngine", async () => {
    const mux = fakeMux();
    const factory = createRealEngineFactory({ mux });
    const engine = await factory("google", "user-1", { executionMode: "non_interactive" });
    expect(engine.constructor.name).toBe("AgyPrintChatEngine");
  });

  it("preserves interactive routing to persistent engine", async () => {
    const mux = fakeMux();
    const factory = createRealEngineFactory({ mux });
    const engine = await factory("google", "user-1", { executionMode: "interactive" });
    expect(engine.constructor.name).toBe("CliChatEngineImpl");
  });
});
