import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("ClaudePrintChatEngine", () => {
  it("runs the first submitted turn with claude print and a fixed session id", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000001"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("hello");

    expect(launchLineAt()).toContain("claude -p");
    expect(launchLineAt()).toContain("--session-id 00000000-0000-4000-8000-000000000001");
    expect(launchLineAt()).toContain("--permission-mode dontAsk");
    expect(launchLineAt()).toContain("--strict-mcp-config");
    expect(launchLineAt()).not.toContain("--permission-mode default");
    expect(launchLineAt()).not.toContain("--no-session-persistence");
    expect(mux.opened).toEqual([]);
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("claude -p")],
      expect.objectContaining({
        cwd: "/tmp/jarvis-neutral",
        detached: true,
        stdio: ["ignore", "ignore", "pipe"]
      })
    );
    expect(await engine.isAlive()).toBe(true);
    await engine.interrupt();
    expect(currentChild.kill).toHaveBeenCalledWith("SIGINT");
    await engine.kill();
    expect(currentChild.kill).toHaveBeenCalledWith("SIGTERM");
    expect(await engine.isAlive()).toBe(false);
  });

  it("uses --resume on later submitted turns", async () => {
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000001"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("first");
    await engine.submit("second");

    expect(launchLineAt(1)).toContain("--resume 00000000-0000-4000-8000-000000000001");
  });

  it("prepends relaunch replay to only the first one-shot prompt", async () => {
    const io = fakeIo();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux: fakeMux(),
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000001"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      replayBatch: "prior fact: Zippledorf-7734"
    });
    await engine.submit("What was the fact?");
    expect(io.writes["/tmp/jarvis-neutral/.jarvis-claude-print-prompt.txt"]).toBe(
      "prior fact: Zippledorf-7734\n\nWhat was the fact?"
    );

    await engine.submit("next turn");
    expect(io.writes["/tmp/jarvis-neutral/.jarvis-claude-print-prompt.txt"]).toBe("next turn");
  });

  it("does not finish teardown until the detached CLI process exits", async () => {
    let exit!: () => void;
    const child = fakeChild();
    Object.assign(child, {
      kill: vi.fn(() => true),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === "exit") exit = callback;
        return child;
      })
    });
    spawnMock.mockReturnValue(child);
    const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
      mux: fakeMux(),
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000010"
    });
    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });
    await engine.submit("hello");

    let settled = false;
    const teardown = engine.kill().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    exit();
    await teardown;
    expect(settled).toBe(true);
  });

  it("reads Claude transcript JSONL through the existing parser", async () => {
    const transcriptPath =
      "/home/test/.claude/projects/-tmp-jarvis-neutral/00000000-0000-4000-8000-000000000001.jsonl";
    const transcript = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "claude print ok" }]
      }
    });
    const io = fakeIo({ [transcriptPath]: `${transcript}\n` });
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000001"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona"
    });

    const result = await engine.readNew(0);

    expect(result.records).toEqual([{ kind: "reply", text: "claude print ok" }]);
    expect(result.complete).toBe(true);
    expect(result.offset).toBe(`${transcript}\n`.length);
  });

  it("launches the authenticated native stream-json contract and reads one structured result", async () => {
    const engine = new ClaudePrintChatEngine("structured-scope", fakeIo(), {
      mux: fakeMux(),
      homeBase: "/home/test"
    });

    await engine.launchStructured({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      model: "claude-haiku-4-5-20251001",
      schema: { type: "object", required: ["ok"] }
    });
    await engine.submitStructured("Return a synthetic structured result.");
    const output = `${JSON.stringify({ type: "result", structured_output: { ok: true } })}\n`;
    currentChild.stdout.write(output);

    const result = await engine.readStructured(0);
    expect(result).toEqual({ text: '{"ok":true}', offset: output.length, complete: true });
    expect(launchLineAt()).toContain("--input-format stream-json");
    expect(launchLineAt()).toContain("--output-format stream-json");
    expect(launchLineAt()).toContain("--include-partial-messages");
    expect(launchLineAt()).toContain("--verbose");
    expect(launchLineAt()).toContain("--no-session-persistence");
    expect(launchLineAt()).toContain("--json-schema");
    expect(spawnMock).toHaveBeenCalledWith(
      "bash",
      ["-lc", expect.stringContaining("--input-format stream-json")],
      expect.objectContaining({
        cwd: "/tmp/jarvis-neutral",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      })
    );
    await engine.kill();
  });

  it("#1353 reads the transcript when the neutral dir contains a surface suffix", async () => {
    // The live-chat neutral dir is `<neutralBase>/<userId>:<surface>`. Claude Code
    // encodes the colon as a dash like every other non-[a-zA-Z0-9-] character, so the
    // ONLY file that ever exists is the dash-encoded one seeded here. Before #1353 the
    // engine computed a colon-bearing path, every read was ENOENT, and the turn ran the
    // full 180s idle watchdog and returned an empty reply with nothing persisted —
    // which is precisely how prod chat looked after the #1350 fix landed.
    const transcriptPath =
      "/home/test/.claude/projects/-tmp-jarvis-neutral-user-1-drawer/" +
      "00000000-0000-4000-8000-000000000009.jsonl";
    const transcript = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "surface-suffixed ok" }]
      }
    });
    const io = fakeIo({ [transcriptPath]: `${transcript}\n` });
    const engine = new ClaudePrintChatEngine("user-1:drawer", io, {
      mux: fakeMux(),
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000009"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral/user-1:drawer",
      personaPath: "/tmp/jarvis-neutral/user-1:drawer/persona.md",
      personaText: "persona"
    });

    const result = await engine.readNew(0);

    expect(result.records).toEqual([{ kind: "reply", text: "surface-suffixed ok" }]);
    expect(result.complete).toBe(true);
  });
});

describe("ClaudePrintChatEngine — vault read-only allowlist (#634)", () => {
  const ROOTS_VAR = "JARVIS_NOTES_ROOTS";
  const originalRoots = process.env[ROOTS_VAR];

  afterEach(() => {
    if (originalRoots === undefined) delete process.env[ROOTS_VAR];
    else process.env[ROOTS_VAR] = originalRoots;
  });

  it("ALLOW: pre-approves Read/Glob/Grep scoped to the configured vault mount", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    const io = fakeIo();
    const mux = fakeMux();
    const engine = new ClaudePrintChatEngine("user-1", io, {
      mux,
      homeBase: "/home/test",
      sessionId: "00000000-0000-4000-8000-000000000002"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis-neutral",
      personaPath: "/tmp/jarvis-neutral/persona.md",
      personaText: "persona",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.submit("hello");

    expect(launchLineAt()).toContain("Read(/data/external-notes/**)");
    expect(launchLineAt()).toContain("Glob(/data/external-notes/**)");
    expect(launchLineAt()).toContain("Grep(/data/external-notes/**)");
    expect(launchLineAt()).toContain("mcp__jarvis__*");
    expect(launchLineAt()).toContain('--tools "Read,Glob,Grep"');
    expect(launchLineAt()).toContain(
      "--settings '/tmp/jarvis-neutral/.jarvis-claude-settings.json'"
    );
    expect(launchLineAt()).not.toContain("jst_abc");
    expect(io.writes["/tmp/jarvis-neutral/.jarvis-claude-permission-token"]).toBeUndefined();
  });

  it("DENY: no vault patterns are granted when no vault is mounted (no roots configured)", async () => {
    delete process.env[ROOTS_VAR];
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
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.submit("hello");

    expect(launchLineAt()).not.toContain("Read(");
    expect(launchLineAt()).not.toContain("Glob(");
    expect(launchLineAt()).not.toContain("Grep(");
    expect(launchLineAt()).toContain("mcp__jarvis__*");
  });

  it("DENY: never grants write or execute tools, even with a vault configured", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
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
      personaText: "persona",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.submit("hello");

    expect(launchLineAt()).not.toMatch(/\bWrite\b/);
    expect(launchLineAt()).not.toMatch(/\bEdit\b/);
    expect(launchLineAt()).not.toMatch(/\bBash\b/);
    expect(launchLineAt()).toContain('--tools "Read,Glob,Grep"');
  });

  it("DENY: a malicious root cannot smuggle a separate Bash(* tool grant (security fix)", async () => {
    process.env[ROOTS_VAR] = "/vault) Bash(*";
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
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.submit("hello");

    expect(launchLineAt()).not.toMatch(/\bBash\b/);
    expect(launchLineAt()).not.toContain("Read(/vault)");
    expect(launchLineAt()).toContain("mcp__jarvis__*");
  });

  describe("#2164 r21 (item 3) toolName passthrough", () => {
    it("carries toolName through readNew for a tool_use event", async () => {
      const transcriptPath =
        "/home/test/.claude/projects/-tmp-jarvis-neutral/00000000-0000-4000-8000-000000000020.jsonl";
      const transcript = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", name: "read_note", input: {} }]
        }
      });
      const io = fakeIo({ [transcriptPath]: `${transcript}\n` });
      const engine = new ClaudePrintChatEngine("user-1", io, {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000020"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });

      const result = await engine.readNew(0);

      expect(result.records).toEqual([{ kind: "tool", text: "read_note", toolName: "read_note" }]);
    });

    it("carries toolCallId and a rejected record through readNew for an mcp__ tool_use plus its errored tool_result", async () => {
      const transcriptPath =
        "/home/test/.claude/projects/-tmp-jarvis-neutral/00000000-0000-4000-8000-000000000023.jsonl";
      const assistantLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_seam1",
              name: "mcp__jarvis__sports_retry_source",
              input: {}
            }
          ]
        }
      });
      const userLine = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_seam1", is_error: true }]
        }
      });
      const io = fakeIo({ [transcriptPath]: `${assistantLine}\n${userLine}\n` });
      const engine = new ClaudePrintChatEngine("user-1", io, {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000023"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });

      const result = await engine.readNew(0);

      const toolRecord = result.records.find((r) => r.kind === "tool" && r.toolName);
      const rejectionRecord = result.records.find((r) => r.kind === "tool" && !r.toolName);
      expect(toolRecord).toMatchObject({ toolCallId: "toolu_seam1" });
      expect(rejectionRecord).toMatchObject({ toolCallId: "toolu_seam1", rejected: true });
    });

    it("carries toolCallId and the rejection record across two separate readNew polls", async () => {
      const transcriptPath =
        "/home/test/.claude/projects/-tmp-jarvis-neutral/00000000-0000-4000-8000-000000000024.jsonl";
      const assistantLine = JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_seam2",
              name: "mcp__jarvis__sports_retry_source",
              input: {}
            }
          ]
        }
      });
      const userLine = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_seam2", is_error: true }]
        }
      });
      const io = fakeIo({ [transcriptPath]: `${assistantLine}\n` });
      const engine = new ClaudePrintChatEngine("user-1", io, {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000024"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });

      const first = await engine.readNew(0);
      expect(first.records).toMatchObject([
        { kind: "tool", toolName: "mcp__jarvis__sports_retry_source", toolCallId: "toolu_seam2" }
      ]);

      io.writes[transcriptPath] = `${assistantLine}\n${userLine}\n`;
      const second = await engine.readNew(first.offset);

      expect(second.records).toMatchObject([
        { kind: "tool", toolCallId: "toolu_seam2", rejected: true }
      ]);
      expect(second.records[0]).not.toHaveProperty("toolName", "mcp__jarvis__sports_retry_source");
    });
  });

  describe("#2164 r21 (item 4) last-submit diagnostics", () => {
    it("returns undefined-exitCode/empty-stderr diagnostics before any submit", () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000021"
      });
      expect(engine.getLastSubmitDiagnostics()).toEqual({ stderrTail: "", exitCode: null });
    });

    it("captures a bounded, scrubbed stderr tail and exit code from the submitted child", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000022"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      await engine.submit("hello");

      currentChild.stderr.write(
        `boom Authorization: Bearer sekrit-token-value and jst_deadbeef and /tmp/jarvis-neutral leaked\n`
      );
      const exitCallback = currentChild.once.mock.calls.find(([event]) => event === "exit")?.[1];
      exitCallback?.(1);
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      expect(diag.exitCode).toBe(1);
      expect(diag.stderrTail).not.toContain("sekrit-token-value");
      expect(diag.stderrTail).not.toContain("jst_deadbeef");
      expect(diag.stderrTail).not.toContain("/tmp/jarvis-neutral");
      expect(diag.stderrTail).toContain("boom");
    });

    it("bounds the captured stderr tail to ~4KB, dropping the oldest bytes", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000023"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      await engine.submit("hello");

      currentChild.stderr.write("a".repeat(3000));
      currentChild.stderr.write("b".repeat(3000));
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      // 3000 "a"s + 3000 "b"s = 6000 chars, bounded to the last 4096: the oldest 1904 "a"s drop,
      // leaving 1096 "a"s followed by all 3000 "b"s.
      expect(diag.stderrTail.length).toBe(4096);
      expect(diag.stderrTail).toBe("a".repeat(1096) + "b".repeat(3000));
    });

    // #2164 r21 security correction (item 2a) — the launch line runs prompt text through
    // `bash -lc "$(cat <promptPath>)"`, so bash expands it into the `claude` child's argv before
    // exec. An error that echoes argv would put the user's prompt text into stderr, and the
    // docstring's promise that the diagnostic "never includes the prompt" was previously
    // unenforced. Proves the current turn's sanitized prompt is scrubbed like any other secret.
    it("scrubs the current turn's prompt text out of a stderr tail that echoes it", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000025"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      const promptText = "the secret prompt marker XYZ789 that must never leak";
      await engine.submit(promptText);

      // #2164 r22 — the prompt-echo line and the failure-reason line are written separately: the
      // r22 fragment scrub drops a whole line containing any 32-char window of the prompt, so a
      // single line carrying both the prompt and "command failed" would drop the failure reason
      // along with the leak. Splitting them proves the scrub still surfaces unrelated diagnostic
      // text while removing the leaking line entirely.
      currentChild.stderr.write(`claude -p "${promptText}" exited unexpectedly\n`);
      currentChild.stderr.write("command failed\n");
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      expect(diag.stderrTail).not.toContain(promptText);
      expect(diag.stderrTail).not.toContain("secret prompt marker XYZ789");
      expect(diag.stderrTail).toContain("command failed");
    });

    // #2164 r21 security correction (item 2b) — `.slice(-4096)` previously ran BEFORE
    // redaction, at accumulation time, so a token whose bytes straddle the trim boundary could
    // survive as an unmatched fragment missing its "jst_" prefix (unredactable — the regex
    // requires the prefix). Builds a buffer already at the 4096 cap with a jst_ token sitting
    // at its very front, then a small later chunk whose length lands the cut exactly inside the
    // token, evicting its "jst_" prefix but leaving the rest — the exact straddle the ruling
    // describes.
    it("does not leak an unmatched token fragment left behind when a jst_ token straddles the 4 KB seam", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000026"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      await engine.submit("hello");

      // Token "jst_deadbeefcafe1234" (20 chars) + "\n" (21 chars) at the very front of an
      // exactly-4096-char buffer.
      const token = "jst_deadbeefcafe1234";
      const tokenLine = `${token}\n`;
      const padding = "z".repeat(4096 - tokenLine.length);
      currentChild.stderr.write(tokenLine + padding);
      await new Promise((resolve) => setImmediate(resolve));

      // A 10-char chunk cuts exactly 10 chars off the front — through "jst_deadbe", the first
      // half of the token — leaving "efcafe1234" as an unmatched, prefix-less fragment.
      currentChild.stderr.write("MOREDATAXY");
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      expect(diag.stderrTail).not.toContain(token);
      expect(diag.stderrTail).not.toContain("efcafe1234");
    });

    // #2164 r22 security correction (item 3) — a prompt longer than the 4096-byte stderr cap can
    // never appear whole in a stderr line, so the r21 whole-literal scrub never matched. Builds a
    // long prompt, then echoes only a middle slice of it (a realistic argv-echo fragment) and
    // proves no 32-char window of the prompt survives.
    it("drops a stderr line containing only a fragment of a too-long prompt", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000027"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      const longPrompt = "secret-instruction-marker-" + "x".repeat(5000) + "-end-of-prompt";
      await engine.submit(longPrompt);

      const fragment = longPrompt.slice(2000, 2100);
      currentChild.stderr.write(`bash: -lc: line 1: claude: ${fragment}\n`);
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      for (let i = 0; i <= longPrompt.length - 32; i += 17) {
        expect(diag.stderrTail).not.toContain(longPrompt.slice(i, i + 32));
      }
    });

    it("keeps a stderr line unrelated to the prompt intact", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000028"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      const longPrompt = "secret-instruction-marker-" + "x".repeat(5000) + "-end-of-prompt";
      await engine.submit(longPrompt);

      currentChild.stderr.write("bash: claude: command not found\n");
      await new Promise((resolve) => setImmediate(resolve));

      const diag = engine.getLastSubmitDiagnostics();
      expect(diag.stderrTail).toContain("bash: claude: command not found");
    });

    it("resets stderr/exit code diagnostics at the start of each submit", async () => {
      const engine = new ClaudePrintChatEngine("user-1", fakeIo(), {
        mux: fakeMux(),
        homeBase: "/home/test",
        sessionId: "00000000-0000-4000-8000-000000000024"
      });
      await engine.launch({
        neutralDir: "/tmp/jarvis-neutral",
        personaPath: "/tmp/jarvis-neutral/persona.md",
        personaText: "persona"
      });
      await engine.submit("first");
      currentChild.stderr.write("first failure\n");
      const firstExit = currentChild.once.mock.calls.find(([event]) => event === "exit")?.[1];
      firstExit?.(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(engine.getLastSubmitDiagnostics().exitCode).toBe(1);

      currentChild = fakeChild();
      spawnMock.mockReturnValue(currentChild);
      await engine.submit("second");

      const diag = engine.getLastSubmitDiagnostics();
      expect(diag.exitCode).toBeNull();
      expect(diag.stderrTail).toBe("");
    });
  });
});
