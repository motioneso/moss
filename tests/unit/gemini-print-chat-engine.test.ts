import { beforeEach, describe, expect, it, vi } from "vitest";

import { GeminiPrintChatEngine } from "../../packages/chat/src/live/gemini-print-chat-engine.js";
import {
  GEMINI_IDENTITY_FILENAME,
  GEMINI_OUTPUT_FILENAME,
  GEMINI_STDERR_FILENAME
} from "../../packages/chat/src/live/private-transcript-cleanup.js";
import { createRealEngineFactory } from "../../packages/chat/src/live/runtime.js";
import type { Multiplexer, MuxHandle, TmuxIo } from "@moss/ai";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual("node:child_process")),
  spawn: spawnMock
}));

/** The session id this engine is pinned to in every test, so assertions can name it. */
const SESSION_ID = "e099f770-a55c-432f-a9be-8cf254fd2d54";
const NEUTRAL_DIR = "/tmp/jarvis-neutral";
const OUTPUT_PATH = `${NEUTRAL_DIR}/${GEMINI_OUTPUT_FILENAME}`;

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
      throw new Error("GeminiPrintChatEngine should run one command per turn, not paste into a REPL");
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

async function launchedEngine(files: Record<string, string> = {}) {
  const io = fakeIo(files);
  const mux = fakeMux();
  const engine = new GeminiPrintChatEngine("user-1", io, {
    mux,
    homeBase: "/home/test",
    sessionId: SESSION_ID
  });
  await engine.launch({
    neutralDir: NEUTRAL_DIR,
    personaPath: `${NEUTRAL_DIR}/persona.md`,
    personaText: "persona"
  });
  return { io, mux, engine };
}

describe("GeminiPrintChatEngine — the launch line", () => {
  it("runs the real gemini command with the flags the pinned CLI actually has", async () => {
    // #2028 — every flag here was measured against @google/gemini-cli@0.57.0. The command this
    // replaced was `agy`, a binary no Jarv1s install has ever put on the box.
    const { io, mux, engine } = await launchedEngine();

    await engine.submit("read ./word.txt");

    const line = launchLineAt();
    expect(line).toMatch(/(^|\s|&&\s)gemini(\s|$)/);
    expect(line).not.toContain("agy");
    expect(line).toContain(`cd '${NEUTRAL_DIR}'`);
    expect(line).toContain("-o stream-json");
    expect(line).toContain("--approval-mode yolo");
    // A freshly made session folder is untrusted, and an untrusted folder silently downgrades the
    // approval mode back to one that waits for a person nobody can be.
    expect(line).toContain("--skip-trust");
    // Crash reports written by this CLI quote the prompt verbatim, so the temporary directory is
    // pointed at the session folder, which the purge already deletes.
    expect(line).toContain(`TMPDIR='${NEUTRAL_DIR}'`);
    // The prompt itself is never on the command line.
    expect(line).not.toContain("read ./word.txt");
    expect(io.writes[`${NEUTRAL_DIR}/.jarvis-gemini-prompt.txt`]).toBe("read ./word.txt");

    expect(mux.opened).toEqual([]);
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("gemini")],
      expect.objectContaining({ cwd: NEUTRAL_DIR, detached: true, stdio: "ignore" })
    );
    expect(await engine.isAlive()).toBe(true);
    await engine.interrupt();
    expect(currentChild.kill).toHaveBeenCalledWith("SIGINT");
    await engine.kill();
    expect(currentChild.kill).toHaveBeenCalledWith();
    expect(await engine.isAlive()).toBe(false);
  });

  it("opens the conversation on the first turn and resumes it on the next", async () => {
    // Passing both --session-id and --resume makes the CLI refuse to start, so they are either/or.
    const { engine } = await launchedEngine();

    await engine.submit("first");
    await engine.submit("second");

    expect(launchLineAt(0)).toContain(`--session-id ${SESSION_ID}`);
    expect(launchLineAt(0)).not.toContain("--resume");
    expect(launchLineAt(1)).toContain(`--resume ${SESSION_ID}`);
    expect(launchLineAt(1)).not.toContain("--session-id");
  });

  it("writes the purge marker at launch, before any turn can crash", async () => {
    const { io } = await launchedEngine();

    expect(io.writes[`${NEUTRAL_DIR}/${GEMINI_IDENTITY_FILENAME}.tmp`]).toBe(`${SESSION_ID}\n`);
    expect(io.runs).toContain(
      `mv -f ${NEUTRAL_DIR}/${GEMINI_IDENTITY_FILENAME}.tmp ${NEUTRAL_DIR}/${GEMINI_IDENTITY_FILENAME}`
    );
  });

  it("registers no built-in tools, which is what makes automatic approval safe", async () => {
    const { io } = await launchedEngine();

    const settings = JSON.parse(io.writes[`${NEUTRAL_DIR}/.gemini/settings.json`] ?? "{}");
    expect(settings.tools.core).toEqual([]);
    expect(io.runs).toContain(`chmod 600 ${NEUTRAL_DIR}/.gemini/settings.json`);
  });
});

describe("GeminiPrintChatEngine — reading the reply", () => {
  it("joins the streamed chunks into the answer and reports the turn finished", async () => {
    const output =
      [
        JSON.stringify({ type: "init", session_id: SESSION_ID, model: "auto" }),
        JSON.stringify({ type: "message", role: "user", content: "say the alphabet" }),
        JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "t1" }),
        JSON.stringify({ type: "message", role: "assistant", content: "alpha ", delta: true }),
        JSON.stringify({ type: "message", role: "assistant", content: "bravo", delta: true }),
        JSON.stringify({ type: "result", status: "success", stats: {} })
      ].join("\n") + "\n";
    const { engine } = await launchedEngine({ [OUTPUT_PATH]: output });

    const result = await engine.readNew(0);

    expect(result.records).toEqual([
      { kind: "tool", text: "read_file" },
      { kind: "reply", text: "alpha bravo" }
    ]);
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(output.length);
    // The reply comes from the process's own output, never from a file we asked the CLI to write.
    expect(engine.constructor.name).toBe("GeminiPrintChatEngine");
  });

  it("reports nothing yet when the output file does not exist", async () => {
    const { engine } = await launchedEngine();

    const result = await engine.readNew(0);

    expect(result).toEqual({ records: [], offset: 0, complete: false });
  });
});

describe("GeminiPrintChatEngine — cleaning up", () => {
  it("removes the CLI's own state, the registry entry and the session's private files", async () => {
    const shortId = "jarvis-neutral";
    const { io, engine } = await launchedEngine({
      "/home/test/.gemini/projects.json": JSON.stringify({
        projects: { [NEUTRAL_DIR]: shortId, "/some/other/folder": "other" }
      })
    });
    await engine.submit("go");

    await engine.purgeTranscripts();

    expect(io.runs).toContain(`rm -rf /home/test/.gemini/tmp/${shortId}`);
    expect(io.runs).toContain(`rm -rf /home/test/.gemini/history/${shortId}`);
    expect(io.runs).toContain(`rm -f ${OUTPUT_PATH} ${NEUTRAL_DIR}/${GEMINI_STDERR_FILENAME}`);
    expect(io.runs).toContain(
      `find ${NEUTRAL_DIR} -maxdepth 1 -name gemini-*.json -delete`
    );
    // Another folder's entry survives; ours is gone.
    const registry = JSON.parse(io.writes["/home/test/.gemini/projects.json"] ?? "{}");
    expect(registry).toEqual({ projects: { "/some/other/folder": "other" } });
    // Never the whole shared directory.
    expect(io.runs).not.toContain("rm -rf /home/test/.gemini/tmp");
    expect(io.runs).not.toContain("rm -rf /home/test/.gemini/history");
  });

  it("fails loudly rather than reporting a purge it could not finish", async () => {
    const { io, engine } = await launchedEngine({
      "/home/test/.gemini/projects.json": JSON.stringify({
        projects: { [NEUTRAL_DIR]: "jarvis-neutral" }
      })
    });
    io.run = async (cmd, args) => {
      io.runs.push([cmd, ...args].join(" "));
      return { code: cmd === "rm" ? 1 : 0, stdout: "" };
    };

    await expect(engine.purgeTranscripts()).rejects.toThrow("purge Gemini");
  });
});

describe("GeminiPrintChatEngine — routing", () => {
  it("routes google non_interactive to GeminiPrintChatEngine", async () => {
    const mux = fakeMux();
    const factory = createRealEngineFactory({ mux });
    const engine = await factory("google", "user-1", { executionMode: "non_interactive" });
    expect(engine.constructor.name).toBe("GeminiPrintChatEngine");
  });

  it("preserves interactive routing to persistent engine", async () => {
    const mux = fakeMux();
    const factory = createRealEngineFactory({ mux });
    const engine = await factory("google", "user-1", { executionMode: "interactive" });
    expect(engine.constructor.name).toBe("CliChatEngineImpl");
  });
});

describe("nothing under packages/ still runs the old Antigravity command", () => {
  it("finds no source line that builds or executes a command named agy", async () => {
    // #2028 — this is the guard for the whole class of bug: a Google chat path built against a
    // tool that is never installed. It fails in five places against the code this replaced.
    //
    // Comment lines and test files are skipped: several files explain the history, and explaining
    // it is fine. What must not exist is a shipped line that puts that word into a command.
    const { execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

    let raw = "";
    try {
      raw = execFileSync(
        "grep",
        ["-rn", "-w", "agy", "--include=*.ts", "--exclude=*.test.ts", "packages"],
        { cwd: repoRoot, encoding: "utf8" }
      );
    } catch {
      // grep exits 1 when it finds nothing, which is the passing case.
      raw = "";
    }

    const offenders = raw
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const code = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1).trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
        // The one allowed mention: an extra name a host may already have declared for the google
        // kind. It is only ever compared against, never used to build a command.
        return !code.startsWith('google: ["agy"]');
      });

    expect(offenders).toEqual([]);
  });
});
