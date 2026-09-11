/**
 * Unit tests for CliChatEngineImpl — the persistent-session CLI engine that
 * drives `claude` inside tmux and exposes it via the CliChatEngine interface.
 *
 * No Postgres, no real tmux, no real `claude` binary: the TmuxIo seam is faked
 * (modelled on ai-tmux-bridge.test.ts) so launch/submit/readNew are asserted
 * against recorded commands and a fixture transcript.
 */
import { describe, expect, it } from "vitest";

import { CliChatEngineImpl } from "../../packages/chat/src/live/module-build-cli-engine.js";
import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";

// ─── anthropic / Claude Code transcript fixtures ─────────────────────────────

const CLAUDE_THINKING = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "thinking", thinking: "let me consider this" }]
  },
  uuid: "u1",
  timestamp: "2026-06-08T00:00:00.000Z"
});

const CLAUDE_FINAL = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Here is the final answer, sir." }]
  },
  uuid: "u2",
  timestamp: "2026-06-08T00:00:02.000Z"
});

/**
 * Fake TmuxIo that records every run/write call and serves a transcript whose
 * contents change after submit() (empty → thinking → final), so readNew can be
 * exercised across the not-yet-created, in-progress, and complete states.
 */
function fakeIo(): TmuxIo & {
  runCalls: Array<{ cmd: string; args: readonly string[] }>;
  writeCalls: Array<{ path: string; content: string }>;
  setTranscript(content: string | null): void;
} {
  const runCalls: Array<{ cmd: string; args: readonly string[] }> = [];
  const writeCalls: Array<{ path: string; content: string }> = [];
  const files = new Map<string, string>();
  let transcript: string | null = null;

  return {
    runCalls,
    writeCalls,
    setTranscript(content: string | null) {
      transcript = content;
    },
    async run(cmd, args) {
      runCalls.push({ cmd, args });
      if (cmd === "bash" && args.join(" ").includes("codex exec --json")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            type: "event_msg",
            payload: { type: "task_complete", last_agent_message: "exec reply" }
          })
        };
      }
      // `tmux has-session` returns 0 (alive) by default in these tests.
      return { code: 0, stdout: "" };
    },
    async readFile(_path) {
      if (transcript === null) {
        const content = files.get(_path);
        if (content !== undefined) return content;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return transcript;
    },
    async writeFile(path, content) {
      writeCalls.push({ path, content });
      files.set(path, content);
    },
    async sleep(_ms) {
      /* no-op in tests */
    }
  };
}

function flat(io: ReturnType<typeof fakeIo>): string {
  // Flatten every run-call into a single searchable string of "cmd arg arg ...".
  return io.runCalls.map((c) => [c.cmd, ...c.args].join(" ")).join("\n");
}

describe("CliChatEngineImpl — launch", () => {
  it("launches `claude` with the security-critical flags from the spike matrix", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-launch", io);

    await engine.launch({
      neutralDir: "/tmp/jarvis/thread-launch",
      personaPath: "/tmp/jarvis/thread-launch/persona.md"
    });

    const all = flat(io);
    // The CLI binary is launched.
    expect(all).toContain("claude");
    // #1071 (revert of #1068): default mode. The seeding + correct HOME suppress the folder-trust
    // wizard under `default`; bypassPermissions instead triggers a blocking accept-warning that
    // wedges the REPL → 503. Tool safety is unchanged — it comes from --tools "" / the allowlist
    // hook, not from --permission-mode.
    expect(all).toContain("--permission-mode default");
    // Native built-in tools disabled via empty allowlist (NOT a denylist).
    expect(all).toContain('--tools ""');
    expect(all).not.toContain("--disallowedTools");
    // Persona injected via the *append* (file) form (path is shell-quoted).
    expect(all).toContain("--append-system-prompt-file '/tmp/jarvis/thread-launch/persona.md'");
    // Transcript filename pinned with a generated session id.
    expect(all).toContain("--session-id");
    // Operator's global MCP servers excluded.
    expect(all).toContain("--strict-mcp-config");
    // cd into the neutral dir before launching (path is shell-quoted).
    expect(all).toContain("cd '/tmp/jarvis/thread-launch'");
  });

  it("computes a transcript path under the dash-encoded cwd with the session id (leading dash kept)", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-path", io);

    await engine.launch({
      neutralDir: "/tmp/jarvis/thread-path",
      personaPath: "/tmp/jarvis/thread-path/persona.md"
    });

    // Pull the generated session id out of the launch command.
    const launchLine = io.runCalls
      .map((c) => c.args.join(" "))
      .find((a) => a.includes("--session-id"));
    expect(launchLine).toBeDefined();
    const sessionId = /--session-id (\S+)/.exec(launchLine ?? "")?.[1];
    expect(sessionId).toBeTruthy();

    const path = engine.transcriptPath();
    expect(path).toContain("/.claude/projects/-tmp-jarvis-thread-path/");
    expect(path.endsWith(`${sessionId}.jsonl`)).toBe(true);
  });

  it("runs Codex exec JSON as a one-shot turn in non-interactive mode", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("openai-compatible", "thread-codex-exec", io, {
      executionMode: "non_interactive"
    });

    await engine.launch({
      neutralDir: "/tmp/jarvis/thread-codex-exec",
      personaPath: "/tmp/jarvis/thread-codex-exec/persona.md",
      personaText: "You are Jarvis.",
      replayBatch: "<conversation>\nUser: earlier\n</conversation>"
    });

    expect(flat(io)).not.toContain("tmux new-session");

    await engine.submit("Reply with ok.");
    const all = flat(io);
    expect(all).toContain("codex exec --json");
    expect(all).toContain("--sandbox read-only");
    // #1242: codex-cli 0.139.0 dropped `exec`'s top-level `-a/--ask-for-approval` flag (passing
    // `-a never` now aborts the launch with "unexpected argument '-a'") and refuses to run outside a
    // trusted git dir. Approval is set via the `approval_policy` config override, and the scratch
    // neutralDir is opted out of the git-trust gate with `--skip-git-repo-check`. Assert the new
    // surface and guard against the old flag creeping back.
    expect(all).toContain("--skip-git-repo-check");
    expect(all).toContain(`approval_policy="never"`);
    expect(all).not.toContain("-a never");
    // #1083 F1: shell_tool/apply_patch_tool must be denied on every codex exec launch, even
    // here where no mcpToken/mcpServerUrl is configured (this launch() call passes neither) —
    // all tool use must route through the gateway, never codex's native shell/apply-patch tools.
    expect(all).toContain("features.shell_tool=false");
    expect(all).toContain("features.apply_patch_tool=false");
    expect(all).not.toContain("mcp_servers.jarvis.url");

    const promptWrite = io.writeCalls.find((call) => call.path.endsWith("codex-exec-prompt.txt"));
    expect(promptWrite?.content).toContain("You are Jarvis.");
    expect(promptWrite?.content).toContain("User: earlier");
    expect(promptWrite?.content).toContain("User: Reply with ok.");
    expect(all).toContain("< '/tmp/jarvis/thread-codex-exec/codex-exec-prompt.txt'");

    const result = await engine.readNew(0);
    expect(result.complete).toBe(true);
    expect(result.records.at(-1)).toEqual({ kind: "reply", text: "exec reply" });

    await engine.submit("Second turn.");
    const secondPrompt = io.writeCalls
      .filter((call) => call.path.endsWith("codex-exec-prompt.txt"))
      .at(-1);
    expect(secondPrompt?.content).toContain("User: Reply with ok.");
    expect(secondPrompt?.content).toContain("Assistant: exec reply");
    expect(secondPrompt?.content).toContain("User: Second turn.");
  });
});

describe("CliChatEngineImpl — submit + readNew", () => {
  it("sanitizes a leading '!' before pasting (no bash-prefix escape hatch)", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-bang", io, {});
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-bang", personaPath: "/p.md" });

    io.writeCalls.length = 0;
    await engine.submit("!rm -rf /");

    expect(io.writeCalls).toHaveLength(1);
    const written = io.writeCalls[0]?.content ?? "";
    expect(written.startsWith("!")).toBe(false);
    expect(written).toContain("rm -rf /");
  });

  it("pastes the prompt buffer then sends Enter as a separate send-keys", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-paste", io, {});
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-paste", personaPath: "/p.md" });

    io.runCalls.length = 0;
    await engine.submit("hello");

    const tmux = io.runCalls.filter((c) => c.cmd === "tmux").map((c) => c.args.join(" "));
    const pasteIdx = tmux.findIndex((a) => a.includes("paste-buffer"));
    const enterIdx = tmux.findIndex((a) => a.includes("send-keys") && a.includes("Enter"));
    expect(pasteIdx).toBeGreaterThanOrEqual(0);
    expect(enterIdx).toBeGreaterThan(pasteIdx);
  });

  it("readNew tolerates a missing transcript (returns empty, not complete)", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-empty", io);
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-empty", personaPath: "/p.md" });

    // transcript stays null → readFile throws ENOENT.
    const res = await engine.readNew(0);
    expect(res.records).toEqual([]);
    expect(res.complete).toBe(false);
    expect(res.offset).toBe(0);
  });

  it("readNew yields a reply record after the turn completes", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-reply", io, {});
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-reply", personaPath: "/p.md" });

    await engine.submit("What is the answer?");

    // Simulate the CLI writing thinking then the final reply.
    io.setTranscript([CLAUDE_THINKING, CLAUDE_FINAL].join("\n"));

    const res = await engine.readNew(0);
    expect(res.complete).toBe(true);
    expect(res.offset).toBeGreaterThan(0);

    const kinds = res.records.map((r) => r.kind);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("reply");
    const reply = res.records.find((r) => r.kind === "reply");
    expect(reply?.text).toBe("Here is the final answer, sir.");
  });

  it("readNew respects afterOffset (skips already-read bytes)", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-offset", io);
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-offset", personaPath: "/p.md" });

    const first = CLAUDE_THINKING + "\n";
    const full = first + CLAUDE_FINAL + "\n";
    io.setTranscript(full);

    const res = await engine.readNew(first.length);
    // Only the final record after the offset is parsed.
    expect(res.records.map((r) => r.kind)).toEqual(["reply"]);
    expect(res.complete).toBe(true);
    expect(res.offset).toBe(full.length);
  });
});

describe("CliChatEngineImpl — lifecycle", () => {
  it("isAlive() checks the tmux session via has-session", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-alive", io);
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-alive", personaPath: "/p.md" });

    io.runCalls.length = 0;
    const alive = await engine.isAlive();
    expect(alive).toBe(true);
    expect(io.runCalls.some((c) => c.cmd === "tmux" && c.args.includes("has-session"))).toBe(true);
  });

  it("kill() kills the tmux session", async () => {
    const io = fakeIo();
    const engine = new CliChatEngineImpl("anthropic", "thread-kill", io);
    await engine.launch({ neutralDir: "/tmp/jarvis/thread-kill", personaPath: "/p.md" });

    io.runCalls.length = 0;
    await engine.kill();

    expect(io.runCalls.some((c) => c.cmd === "tmux" && c.args.includes("kill-session"))).toBe(true);
  });
});
