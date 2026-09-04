import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Multiplexer } from "../../packages/ai/src/adapters/multiplexer.js";
import { createRealTmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineImpl, probeProvider } from "../../packages/chat/src/live/cli-chat-engine.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { clearProviderProbeCacheForTests } from "../../packages/chat/src/live/provider-probe.js";

function makeIo() {
  return {
    run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    sleep: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined)
  };
}

function makeGeminiIo() {
  const io = makeIo();
  io.run.mockImplementation(async (cmd: string, args: string[]) =>
    cmd === "tmux" && args.includes("capture-pane")
      ? { code: 0, stdout: ">\n? for shortcuts\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "" }
  );
  return io;
}

const CODEX_TEST_UUID = "019f5af9-3c61-7f72-af47-09514db9892c";

function codexIdentityMux(): Multiplexer {
  const panes = [
    "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
    "› /status\n",
    `│  Session:  ${CODEX_TEST_UUID}  │\n`
  ];
  return {
    kind: "tmux",
    open: async () => "handle",
    submit: async () => undefined,
    clearComposer: async () => undefined,
    clearComposerHard: async () => undefined,
    capturePane: async () => panes.shift() ?? panes.at(-1)!,
    paste: async () => undefined,
    pressEnter: async () => undefined,
    isAlive: async () => true,
    kill: async () => undefined,
    interrupt: async () => undefined,
    attachCommand: () => ""
  };
}

function makeCodexIo() {
  const io = makeIo();
  const panes = [
    "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
    "› /status\n",
    `│  Session:  ${CODEX_TEST_UUID}  │\n`
  ];
  let captures = 0;
  io.run.mockImplementation(async (cmd: string, args: string[]) =>
    cmd === "tmux" && args.includes("capture-pane")
      ? { code: 0, stdout: panes[captures++] ?? panes.at(-1)!, stderr: "" }
      : { code: 0, stdout: "", stderr: "" }
  );
  return io;
}

// ─── #342 probeProvider (§4.8) — no token, no replay ─────────────────────────────
describe("probeProvider (§4.8)", () => {
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  it("returns not_installed when the binary is absent (no auth command run)", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const res = await probeProvider("anthropic", {
      io: { run },
      cliPresent: async () => false
    });
    expect(res.status).toBe("not_installed");
    // Pure presence check: no `claude auth status` is ever spawned.
    expect(run).not.toHaveBeenCalled();
  });

  it("returns ready when the real one-shot call succeeds (#2232)", async () => {
    // #2232: the probe no longer trusts `claude auth status` (which only checks that a token
    // FILE is present). It now makes a real `claude --print` call and only reports ready when
    // that call actually answers.
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "OK\n",
      stderr: ""
    });
    const res = await probeProvider("anthropic", { io: { run }, cliPresent: async () => true });
    expect(res.status).toBe("ready");
  });

  it("returns needs_login when the real call fails authentication (#2232, lineage #342)", async () => {
    // The saved token has expired: the real call exits non-zero and the CLI reports the
    // failure as an authentication error, not as a plain crash.
    const run = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "API Error: 401 invalid bearer token"
    });
    const res = await probeProvider("anthropic", { io: { run }, cliPresent: async () => true });
    expect(res.status).toBe("needs_login");
  });

  it("injects the claude-scoped credentialEnv into the real probe call (#363, #2232)", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "OK\n",
      stderr: ""
    });
    const credentialEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-PROBE" };
    const res = await probeProvider("anthropic", {
      io: { run },
      cliPresent: async () => true,
      credentialEnv
    });
    expect(res.status).toBe("ready");
    // The token is passed per-call via opts.env (claude-scoped), not the global allowlist.
    expect(run).toHaveBeenCalledWith("claude", ["--print", "Reply with exactly OK."], {
      env: credentialEnv
    });
  });

  it("surfaces multiplexer_unavailable when the mux is not usable", async () => {
    const run = vi.fn();
    const res = await probeProvider("anthropic", {
      io: { run },
      cliPresent: async () => true,
      multiplexerUsable: async () => false
    });
    expect(res.status).toBe("multiplexer_unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});

// ─── #342 §12 (4b) DOCUMENTING test: 0600 + redactSecrets do NOT protect a same-UID
// read of the per-session token file. The single-active-user gate — NOT the file mode —
// is the isolation boundary until #347 (§13). This test exists so nobody mistakes
// `0600` for a cross-user boundary. (fs/os/path + createRealTmuxIo imported at top of file.)

describe("#342 §13 same-UID token-file readability (DOCUMENTING — not a regression)", () => {
  it("a 0600 Codex token file is readable by the SAME uid that wrote it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarv1s-342-tokenfile-"));
    try {
      // Use the REAL io so chmod 600 actually applies on disk.
      const io = createRealTmuxIo();
      const engine = new CliChatEngineImpl("openai-compatible", "same-uid", io, {
        // No mux.open → use a fake mux so we don't need a real tmux for this file check.
        mux: codexIdentityMux()
      });
      await engine.launch({
        neutralDir: dir,
        personaPath: join(dir, "persona.md"),
        personaText: "You are Jarvis.",
        mcpToken: "jst_same_uid_secret",
        mcpServerUrl: "http://api:3000/api/mcp"
      });

      // The file is 0600 — yet the SAME uid (this test process) reads it back plainly.
      // redactSecrets is a LOG-redaction tool, not a file-access control: the token is
      // present in cleartext in the file. This is the documented Phase-1 limitation
      // that the single-active-user gate (#347) compensates for.
      const tokenFile = join(dir, ".jarvis-mcp-token.env");
      const contents = await readFile(tokenFile, "utf8");
      expect(contents).toContain("jst_same_uid_secret");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── #342 §6.7 acceptance: the token is ABSENT from launch line / argv / tmux env ────
// §6.2 forbids `tmux set-environment`/`set-env` for the MCP token (show-environment is a
// capture surface). §6.7 requires negative argv assertions for ALL providers (today only
// Claude had them). The send-keys launchLine BECOMES the spawned CLI's argv when tmux runs
// it, so a launchLine free of any token/Bearer/Authorization shape is exactly the
// /proc/<pid>/cmdline guarantee §6.7 asks for.
describe("CliChatEngineImpl — §6.7 no secret on launch line / argv / tmux env", () => {
  function launchLineFrom(io: ReturnType<typeof makeIo>): string {
    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    expect(sendKeysCall).toBeDefined();
    return (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })()!;
  }

  function assertNoTmuxEnvCarriesSecret(io: ReturnType<typeof makeIo>): void {
    // (a) §6.2/§6.7: NO `tmux set-environment`/`set-env` carrying a jst_/Bearer value is
    // ever issued at launch — the token reaches the CLI ONLY via the per-session 0600 file.
    const envCalls = (io.run as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) => {
      if (c[0] !== "tmux") return false;
      const rawArgs = c[1] as string[];
      const verb = (rawArgs[0] === "-S" ? rawArgs[2] : rawArgs[0]) ?? "";
      return verb === "set-environment" || verb === "set-env" || verb === "setenv";
    });
    expect(envCalls).toEqual([]);
    // Belt-and-suspenders: even if a set-environment were issued, no tmux arg anywhere may
    // carry a token/Bearer/Authorization shape.
    for (const c of (io.run as ReturnType<typeof vi.fn>).mock.calls) {
      if (c[0] !== "tmux") continue;
      const args = (c[1] as string[]).join(" ");
      expect(args).not.toMatch(/jst_/);
      expect(args).not.toMatch(/Bearer/);
      expect(args).not.toMatch(/Authorization/);
    }
  }

  it("Claude: launch line / argv carry no jst_/Bearer/Authorization and no tmux set-environment", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "claude-secret", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_claude_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });
    const launchLine = launchLineFrom(io);
    expect(launchLine).not.toContain("jst_claude_secret");
    expect(launchLine).not.toContain("Bearer");
    expect(launchLine).not.toContain("Authorization");
    assertNoTmuxEnvCarriesSecret(io);
  });

  it("Codex: launch line / argv carry no jst_/Bearer/Authorization and no tmux set-environment (§6.7 new)", async () => {
    const io = makeCodexIo();
    const engine = new CliChatEngineImpl("openai-compatible", "codex-secret", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_codex_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });
    const launchLine = launchLineFrom(io);
    // Only the env-var NAME may appear, never the token value or a Bearer/Authorization header.
    expect(launchLine).toContain("JARVIS_MCP_TOKEN");
    expect(launchLine).not.toContain("jst_codex_secret");
    expect(launchLine).not.toContain("Bearer");
    expect(launchLine).not.toContain("Authorization");
    assertNoTmuxEnvCarriesSecret(io);
  });

  it("Gemini: launch line / argv carry no jst_/Bearer/Authorization and no tmux set-environment (§6.7 new)", async () => {
    const io = makeGeminiIo();
    const engine = new CliChatEngineImpl("google", "gemini-secret", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_gemini_secret",
      mcpServerUrl: "http://api:3000/api/mcp"
    });
    const launchLine = launchLineFrom(io);
    // Gemini's token lives ONLY in .gemini/settings.json; the launch line never carries it.
    expect(launchLine).not.toContain("jst_gemini_secret");
    expect(launchLine).not.toContain("Bearer");
    expect(launchLine).not.toContain("Authorization");
    assertNoTmuxEnvCarriesSecret(io);
  });
});

// ─── #342 Gemini chmod symmetry (security fix §6.5) ──────────────────────────────
describe("CliChatEngineImpl — Gemini settings chmod failure cleanup", () => {
  it("rm -f's the settings file and fails the launch if `chmod 600` fails (no readable token left)", async () => {
    const io = makeIo();
    // Make ONLY the settings chmod fail; everything else succeeds.
    (io.run as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "chmod" && (args[1] ?? "").endsWith(".gemini/settings.json")) {
        return { code: 1, stdout: "", stderr: "chmod: operation not permitted" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const engine = new CliChatEngineImpl("google", "gemini-chmod-fail", io);

    let caught: unknown;
    try {
      await engine.launch({
        neutralDir: "/tmp/neutral-gem",
        personaPath: "/tmp/persona.txt",
        mcpToken: "jst_gem_locked",
        mcpServerUrl: "http://api:3000/api/mcp"
      });
    } catch (err) {
      caught = err;
    }

    // The pre-mux-create write failure surfaces as the 503-mapped unavailable error.
    expect(caught).toBeInstanceOf(CliChatUnavailableError);
    // The settings file was rm -f'd (symmetry with Claude/Codex) so no readable Bearer survives.
    expect(io.run).toHaveBeenCalledWith("rm", ["-f", "/tmp/neutral-gem/.gemini/settings.json"]);
    // And the whole per-session neutral dir is torn down on the failed launch (§6.5).
    expect(io.run).toHaveBeenCalledWith("rm", ["-rf", "/tmp/neutral-gem"]);
    // The mux session was NEVER opened (pre-mux-create failure) — no orphan to reap.
    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    expect(sendKeysCall).toBeUndefined();
  });
});

// ─── #342 UNPROVEN-2: POST-mux-create failure kills the mux session BEFORE rm -rf'ing the
// neutral dir (§6.5 ordering). If the dir were removed first, the live jarv1s-live-<key>
// session would linger in listLiveSessions-by-mux and wedge the §4.1.0a single-user gate
// for everyone until reconciliation/restart. ──────────────────────────────────────────
describe("CliChatEngineImpl — §6.5 POST-mux-create failure ordering (UNPROVEN-2)", () => {
  it("kills jarv1s-live-<key> BEFORE rm -rf'ing the neutral dir when the drain fails post-launch", async () => {
    const events: string[] = [];
    const io = makeIo();
    // Record rm -rf of the neutral dir in submission order.
    (io.run as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "rm" && (args[0] ?? "") === "-rf") {
        events.push(`rm:${args[1]}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    // A mux that OPENS successfully (so jarv1s-live-<key> exists), but whose paste throws
    // and whose cleanup cannot prove the composer empty — driving verified replay to fail, which is a
    // POST-mux-create failure routed through killAndRemoveNeutralDirQuietly.
    const killSpy = vi.fn().mockImplementation(async () => {
      events.push("mux.kill");
    });
    const mux: Multiplexer = {
      kind: "tmux",
      open: vi.fn().mockResolvedValue("jarv1s-live-rpc-post-fail"),
      submit: vi.fn().mockRejectedValue(new Error("paste-buffer failed")),
      clearComposer: vi.fn(),
      clearComposerHard: vi.fn(),
      capturePane: vi.fn().mockResolvedValueOnce("❯\n").mockResolvedValue("❯ private draft\n"),
      paste: vi.fn().mockRejectedValue(new Error("paste-buffer failed")),
      pressEnter: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(true),
      kill: killSpy,
      interrupt: vi.fn(),
      attachCommand: () => ""
    };

    const engine = new CliChatEngineImpl("anthropic", "rpc-post-fail", io, {
      mux,
      ownsDrain: true,
      drainMs: 50,
      drainPollMs: 1,
      echoMs: 0
    });

    let caught: unknown;
    try {
      await engine.launch({
        neutralDir: "/data/cli-auth/chat/rpc-post-fail",
        personaPath: "/data/cli-auth/chat/rpc-post-fail/persona.md",
        personaText: "You are Jarvis.",
        replayBatch: "prior conversation here",
        mcpToken: "jst_x",
        mcpServerUrl: "http://api:3000/api/mcp"
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliChatUnavailableError);
    // The mux session was opened, the drain failed, and the session was killed.
    expect(killSpy).toHaveBeenCalledTimes(1);
    // CRITICAL ORDERING (§6.5): the kill happens BEFORE the neutral dir is rm -rf'd, so
    // the orphaned jarv1s-live-* session can never wedge the §4.1.0a gate.
    const killIdx = events.indexOf("mux.kill");
    const rmIdx = events.indexOf("rm:/data/cli-auth/chat/rpc-post-fail");
    expect(killIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeLessThan(rmIdx);
  });

  it("a failed launch removes the neutral dir (§6.5)", async () => {
    const io = makeIo();
    const removed: string[] = [];
    (io.run as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "rm" && (args[0] ?? "") === "-rf") removed.push(args[1] ?? "");
      return { code: 0, stdout: "", stderr: "" };
    });
    // PRE-mux-create failure: mux.open throws, so the neutral dir is removed and no mux
    // session is ever opened.
    const mux: Multiplexer = {
      kind: "tmux",
      open: vi.fn().mockRejectedValue(new Error("tmux new-session failed")),
      submit: vi.fn(),
      clearComposer: vi.fn(),
      clearComposerHard: vi.fn(),
      capturePane: vi.fn().mockResolvedValue(""),
      paste: vi.fn(),
      pressEnter: vi.fn(),
      isAlive: vi.fn().mockResolvedValue(false),
      kill: vi.fn(),
      interrupt: vi.fn(),
      attachCommand: () => ""
    };
    const engine = new CliChatEngineImpl("anthropic", "rpc-pre-fail", io, { mux, ownsDrain: true });

    await expect(
      engine.launch({
        neutralDir: "/data/cli-auth/chat/rpc-pre-fail",
        personaPath: "/data/cli-auth/chat/rpc-pre-fail/persona.md",
        personaText: "You are Jarvis."
      })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);

    expect(removed).toContain("/data/cli-auth/chat/rpc-pre-fail");
  });
});
