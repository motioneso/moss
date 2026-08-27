import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CliChatEngineImpl,
  deriveNeutralDir,
  killMuxSessionByName,
  listLiveMuxSessions,
  composerHasExactEcho,
  isComposerEmpty,
  sanitizeSessionKey,
  SESSION_PREFIX
} from "../../packages/chat/src/live/cli-chat-engine.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { GEMINI_IDENTITY_FILENAME } from "../../packages/chat/src/live/private-transcript-cleanup.js";
import type { Multiplexer } from "../../packages/ai/src/adapters/multiplexer.js";

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

function makeCodexIo(uuid = CODEX_TEST_UUID) {
  const io = makeIo();
  const panes = [
    "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
    "› /status\n",
    `│  Session:  ${uuid}  │\n`
  ];
  let captures = 0;
  io.run.mockImplementation(async (cmd: string, args: string[]) =>
    cmd === "tmux" && args.includes("capture-pane")
      ? { code: 0, stdout: panes[captures++] ?? panes.at(-1)!, stderr: "" }
      : { code: 0, stdout: "", stderr: "" }
  );
  return io;
}

describe("observed composer evidence", () => {
  const bold = "\u001b[1m";
  const dim = "\u001b[2m";
  const reset = "\u001b[0m";

  // #1073: real claude 2.1.183 panes captured live via `tmux capture-pane -e` (uid 1000).
  // IDLE = empty composer: dim (SGR 2) placeholder. Placeholder copy rotates between runs,
  // so detection must key on the dim SGR, not the exact string.
  const ANTHROPIC_2_1_183_EMPTY_PANE = [
    "[38;5;245mClaude Code v2.1.183 · Sonnet 4.6[39m",
    "",
    '[39m❯ [2mTry "fix typecheck errors"[39m',
    "? for shortcuts · ← for agents"
  ].join("\n");

  // TYPED = a real user prompt in the composer. NOT dim (no [2m before the text).
  const ANTHROPIC_2_1_183_TYPED_PROMPT = "ZZPROBEZZ sample typed text";
  const ANTHROPIC_2_1_183_TYPED_PANE = [
    "[38;5;245mClaude Code v2.1.183 · Sonnet 4.6[39m",
    "",
    "[39m❯ ZZPROBEZZ sample typed text",
    "? for shortcuts · ← for agents"
  ].join("\n");

  it("positively recognizes calibrated empty composer signatures", () => {
    expect(isComposerEmpty("anthropic", `${bold}❯${reset}\u00a0\n`)).toBe(true);
    expect(isComposerEmpty("anthropic", ANTHROPIC_2_1_183_EMPTY_PANE)).toBe(true);
    expect(isComposerEmpty("anthropic", ANTHROPIC_2_1_183_TYPED_PANE)).toBe(false);
    expect(
      isComposerEmpty("openai-compatible", `${bold}›${reset} ${dim}Use /skills${reset}\n`)
    ).toBe(true);
    expect(isComposerEmpty("google", ">\n? for shortcuts\n")).toBe(true);

    expect(isComposerEmpty("anthropic", `❯ private text\n`)).toBe(false);
    expect(isComposerEmpty("openai-compatible", `${bold}›${reset} private text\n`)).toBe(false);
    expect(isComposerEmpty("google", "> private text\n")).toBe(false);
  });

  it("matches only the current composer, including wrapped payloads", () => {
    const payload = "fixed payload across columns";
    const oldHistory = `› ${payload}\nmodel reply\n`;

    expect(
      composerHasExactEcho(
        "openai-compatible",
        `${oldHistory}${bold}›${reset} ${dim}Use /skills${reset}\n`,
        payload
      )
    ).toBe(false);
    expect(
      composerHasExactEcho(
        "openai-compatible",
        `${oldHistory}${bold}›${reset} fixed payload across\ncolumns\n`,
        payload
      )
    ).toBe(true);
    expect(
      composerHasExactEcho(
        "anthropic",
        ANTHROPIC_2_1_183_TYPED_PANE,
        ANTHROPIC_2_1_183_TYPED_PROMPT
      )
    ).toBe(true);
    expect(composerHasExactEcho("anthropic", `❯ prefix ${payload} suffix\n`, payload)).toBe(false);
  });
});

function stateMachineMux(opts: {
  readonly panes: readonly string[];
  readonly onPaste?: () => void;
  readonly onEnter?: () => void;
}): Multiplexer & {
  readonly clearComposer: ReturnType<typeof vi.fn>;
  readonly clearComposerHard: ReturnType<typeof vi.fn>;
  readonly capturePane: ReturnType<typeof vi.fn>;
  readonly paste: ReturnType<typeof vi.fn>;
  readonly pressEnter: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const panes = [...opts.panes];
  const capturePane = vi.fn(async () => panes.shift() ?? panes.at(-1) ?? "");
  const paste = vi.fn(async () => opts.onPaste?.());
  const pressEnter = vi.fn(async () => opts.onEnter?.());
  return {
    kind: "tmux",
    open: vi.fn().mockResolvedValue("pane-1"),
    clearComposer: vi.fn().mockResolvedValue(undefined),
    clearComposerHard: vi.fn().mockResolvedValue(undefined),
    capturePane,
    paste,
    pressEnter,
    submit: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn().mockResolvedValue(true),
    kill: vi.fn().mockResolvedValue(undefined),
    attachCommand: vi.fn().mockReturnValue("tmux attach -t pane-1")
  };
}

function claudeUser(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

describe("CliChatEngineImpl — purgeable identity launch gate", () => {
  it("refuses Codex launch when exact /status UUID capture fails", async () => {
    const empty = "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n";
    const mux = stateMachineMux({ panes: [empty, "› /status\n", "Session: unavailable\n"] });
    const engine = new CliChatEngineImpl("openai-compatible", "codex-no-identity", makeIo(), {
      mux,
      echoMs: 0
    });

    await expect(
      engine.launch({ neutralDir: "/tmp/codex-no-identity", personaPath: "/p.md" })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);
    expect(mux.kill).toHaveBeenCalled();
  });

  it("refuses interactive Gemini launch when the purge marker cannot be written", async () => {
    // #2028 — the session id is ours now, so nothing is scraped out of a log. What launch still
    // MUST prove is that the marker landed on disk: without it a crash mid-turn leaves the
    // founder's conversation with no pointer for the boot sweep to purge by.
    const mux = stateMachineMux({ panes: [">\n? for shortcuts\n"] });
    const io = makeIo();
    io.run.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "tmux" && args.includes("capture-pane"))
        return { code: 0, stdout: ">\n? for shortcuts\n", stderr: "" };
      if (cmd === "chmod") return { code: 1, stdout: "", stderr: "denied" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const engine = new CliChatEngineImpl("google", "gemini-no-marker", io, {
      mux,
      echoMs: 0
    });

    await expect(
      engine.launch({ neutralDir: "/tmp/gemini-no-marker", personaPath: "/p.md" })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);
    expect(mux.kill).toHaveBeenCalled();
  });
});

describe("CliChatEngineImpl — vault read-only allowlist (#634)", () => {
  const ROOTS_VAR = "JARVIS_NOTES_ROOTS";
  const originalRoots = process.env[ROOTS_VAR];

  afterEach(() => {
    if (originalRoots === undefined) delete process.env[ROOTS_VAR];
    else process.env[ROOTS_VAR] = originalRoots;
  });

  it("ALLOW: pre-approves Read/Glob/Grep scoped to the configured vault mount", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "vault-allow-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain("Read(/data/external-notes/**)");
    expect(launchLine).toContain("Glob(/data/external-notes/**)");
    expect(launchLine).toContain("Grep(/data/external-notes/**)");
    expect(launchLine).toContain("mcp__jarvis__*");
  });

  it("DENY: a path outside the configured vault root is never allowlisted", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "vault-scope-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    // No blanket grant — only the configured root is scoped in, e.g. not "/etc" or "/" or home.
    expect(launchLine).not.toContain("Read(/**)");
    expect(launchLine).not.toContain("Read(/etc");
    expect(launchLine).not.toContain("Read(~");
  });

  it("DENY: no vault patterns are granted when no vault is mounted (no roots configured)", async () => {
    delete process.env[ROOTS_VAR];
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "no-vault-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("Read(");
    expect(launchLine).not.toContain("Glob(");
    expect(launchLine).not.toContain("Grep(");
    expect(launchLine).toContain("mcp__jarvis__*");
  });

  it("DENY: never grants write or execute tools, even with a vault configured", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "vault-no-write-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("Write(");
    expect(launchLine).not.toContain("Edit(");
    expect(launchLine).not.toContain("Bash(");
    expect(launchLine).not.toMatch(/\bWrite\b/);
    expect(launchLine).not.toMatch(/\bEdit\b/);
    expect(launchLine).not.toMatch(/\bBash\b/);
  });

  it("DENY: a malicious root cannot smuggle a separate Bash(* tool grant (security fix)", async () => {
    process.env[ROOTS_VAR] = "/vault) Bash(*";
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "vault-injection-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toMatch(/\bBash\b/);
    expect(launchLine).not.toContain("Read(/vault)");
    expect(launchLine).toContain("mcp__jarvis__*");
  });

  it("DENY: a root containing '..' cannot escape the vault directory", async () => {
    process.env[ROOTS_VAR] = "/data/external-notes/..";
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "vault-traversal-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("Read(");
    expect(launchLine).not.toContain("Glob(");
    expect(launchLine).not.toContain("Grep(");
    expect(launchLine).toContain("mcp__jarvis__*");
  });
});

describe("CliChatEngineImpl — claude OAuth token injection (#363)", () => {
  it("prefixes the claude launch with CLAUDE_CODE_OAUTH_TOKEN read at runtime ($(cat file)) — token NOT in the line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jarv1s-363-cred-"));
    try {
      const TOKEN = "sk-ant-oat-LAUNCH1234567890abcdefghij";
      const credentialFile = join(dir, "anthropic");
      await writeFile(credentialFile, TOKEN, { mode: 0o600 });
      const io = makeIo();
      const engine = new CliChatEngineImpl("anthropic", "cred-session", io, { credentialFile });
      await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });
      const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
      );
      const launchLine = (() => {
        const a = sendKeysCall![1] as string[];
        return a[a.indexOf("-t") + 2];
      })();
      expect(launchLine).toContain(`CLAUDE_CODE_OAUTH_TOKEN="$(cat '${credentialFile}')"`);
      // The secret value itself is read at runtime — NEVER in the tmux argv / pane-typed line.
      expect(launchLine).not.toContain(TOKEN);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits the token prefix when no credentialFile is configured", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "no-cred-session", io);
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });
    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("CliChatEngineImpl — Codex launch", () => {
  it("launches codex with MCP config -c flags and a sourced token file", async () => {
    const io = makeCodexIo();
    const engine = new CliChatEngineImpl("openai-compatible", "codex-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_codex",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain("codex");
    expect(launchLine).toContain(".jarvis-mcp-token.env");
    expect(launchLine).toContain('bearer_token_env_var="JARVIS_MCP_TOKEN"');
    expect(launchLine).not.toContain("JARVIS_MCP_TOKEN=jst_codex");
    expect(launchLine).not.toContain("jst_codex");
    expect(launchLine).toContain("mcp_servers.jarvis.url");
    expect(launchLine).toContain('mcp_servers.jarvis.default_tools_approval_mode="approve"');
    expect(launchLine).toContain("shell_tool=false");
    expect(launchLine).toContain("apply_patch_tool=false");
    expect(launchLine).toContain("tool_call_mcp_elicitation=false");
    expect(launchLine).toContain("--disable apps");
    expect(launchLine).toContain("sandbox read-only");
    expect(launchLine).toContain("-a never");
    expect(launchLine).toContain('approval_policy="never"');
    expect(launchLine).not.toContain("web_search");
    expect(launchLine).not.toContain("browser");
    expect(launchLine).not.toContain("browse");

    const writeCall = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith(".jarvis-mcp-token.env")
    );
    expect(writeCall?.[1]).toContain("jst_codex");
    expect(io.run).toHaveBeenCalledWith("chmod", ["600", "/tmp/neutral/.jarvis-mcp-token.env"]);

    await engine.kill();
    // §6.5: kill removes the ENTIRE per-session neutral dir (not just the token file).
    expect(io.run).toHaveBeenCalledWith("rm", ["-rf", "/tmp/neutral"]);
  });

  it("#1083 F1: denies shell_tool/apply_patch_tool even with no mcpToken/mcpServerUrl (no gateway configured)", async () => {
    const io = makeCodexIo();
    const engine = new CliChatEngineImpl("openai-compatible", "codex-no-mcp-session", io);
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    // Previously these flags were only pushed inside the `mcpToken && mcpServerUrl` branch, so a
    // codex launch with no gateway configured got codex's native (enabled) shell/apply-patch
    // tools by default. They must be unconditional — every codex launch denies them.
    expect(launchLine).toContain("shell_tool=false");
    expect(launchLine).toContain("apply_patch_tool=false");
    expect(launchLine).not.toContain("mcp_servers.jarvis.url");
  });
});

describe("CliChatEngineImpl — Gemini launch", () => {
  it("writes .gemini/settings.json and launches the real gemini command", async () => {
    const io = makeGeminiIo();
    const engine = new CliChatEngineImpl("google", "gemini-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_gemini",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    const writeCall = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes(".gemini/settings.json")
    );
    expect(writeCall).toBeDefined();
    const settingsContent = JSON.parse(writeCall![1] as string);
    expect(settingsContent.mcpServers.jarvis.httpUrl).toBe("http://127.0.0.1:3000/api/mcp");
    expect(settingsContent.mcpServers.jarvis.headers.Authorization).toBe("Bearer jst_gemini");

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    // #2028 — the CLI this launches is `@google/gemini-cli`. It has no `--sandbox` and no
    // `--log-file`; passing the old Antigravity flags meant no Google session could ever start.
    expect(settingsContent.tools.core).toEqual([]);
    expect(settingsContent.security).toBeUndefined();
    expect(launchLine).toMatch(/(^|\s|&&\s)gemini(\s|$)/);
    expect(launchLine).not.toContain("agy");
    expect(launchLine).not.toContain("--sandbox");
    expect(launchLine).not.toContain("--log-file");
    expect(launchLine).toContain("--skip-trust");
    expect(launchLine).toMatch(
      /--session-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    );
    expect(launchLine).not.toContain("--resume");
    expect(launchLine).toContain("--approval-mode default");
    expect(launchLine).not.toContain("--allowed-mcp-server-names");
    expect(launchLine).not.toContain("web_search");
    expect(launchLine).not.toContain("browser");
    expect(launchLine).not.toContain("browse");
  });

  it("purges the Gemini state this session created, and nothing above it, before kill", async () => {
    const shortId = "gemini-private";
    const io = makeGeminiIo();
    io.readFile.mockImplementation(async (path: string) =>
      path.endsWith("projects.json")
        ? JSON.stringify({ projects: { "/tmp/gemini-private": shortId } })
        : ""
    );
    const engine = new CliChatEngineImpl("google", "gemini-private", io, {
      homeBase: "/host-home"
    });
    await engine.launch({
      neutralDir: "/tmp/gemini-private",
      personaPath: "/tmp/persona.txt"
    });
    await engine.submit("fixed marker");
    await engine.readNew(0);

    await engine.purgeTranscripts();
    await engine.kill();

    expect(io.run.mock.calls).toContainEqual(["rm", ["-rf", `/host-home/.gemini/tmp/${shortId}`]]);
    expect(io.run.mock.calls).toContainEqual([
      "rm",
      ["-rf", `/host-home/.gemini/history/${shortId}`]
    ]);
    expect(JSON.stringify(io.run.mock.calls)).not.toContain(
      '["rm",["-rf","/host-home/.gemini/tmp"]]'
    );
  });
});

describe("CliChatEngineImpl — homeBase seam (#deployable-stack §6)", () => {
  it("resolves the transcript path under the provided homeBase", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "host-session", io, {
      homeBase: "/host-home"
    });
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    expect(engine.transcriptPath().startsWith("/host-home/.claude/projects/")).toBe(true);
  });

  it("falls back to the OS home when no homeBase is given", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "local-session", io);
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    expect(engine.transcriptPath()).not.toContain("/host-home/");
    expect(engine.transcriptPath()).toContain("/.claude/projects/");
  });
});

describe("CliChatEngineImpl — provider transcript resolution", () => {
  it("Claude still reads the session-id-pinned transcript path", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "claude-session", io, {
      homeBase: "/host-home"
    });
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    io.readFile.mockResolvedValue("");
    await engine.readNew(0);

    // Claude reads the pinned <sessionId>.jsonl directly; it never globs with `ls -t`.
    const lsCall = io.run.mock.calls.find((c: unknown[]) => c[0] === "ls");
    expect(lsCall).toBeUndefined();
    const readPath = io.readFile.mock.calls[0]?.[0] as string;
    expect(readPath).toMatch(/\/host-home\/\.claude\/projects\/.+\/[0-9a-f-]+\.jsonl$/);
  });

  it("Gemini resolves the newest .jsonl under the cwd-specific ~/.gemini/tmp project chats dir", async () => {
    const io = makeGeminiIo();
    const engine = new CliChatEngineImpl("google", "gemini-session", io, {
      homeBase: "/host-home"
    });
    await engine.launch({
      neutralDir: "/tmp/jarv1s-provider-check-AbC123",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_gemini",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    io.run.mockImplementation(async (cmd: string) => {
      if (cmd === "ls") {
        return { code: 0, stdout: "session-2026-06-13T10-00-00-xyz.jsonl\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    io.readFile.mockResolvedValue("");

    await engine.readNew(0);

    const readPath = io.readFile.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("/.gemini/tmp/")
    )?.[0] as string;
    expect(readPath).toContain("/host-home/.gemini/tmp/jarv1s-provider-check-abc123/chats/");
    expect(readPath.endsWith("session-2026-06-13T10-00-00-xyz.jsonl")).toBe(true);
  });
});

// Branch-review LOW (cli-chat-engine.ts:253): the launch line carries the per-session
// MCP bearer token inline (Codex env-var prefix). A backend whose thrown error echoes
// the launch line must never carry the token into the server log via the wrapped cause.
describe("CliChatEngineImpl — failure-path token redaction", () => {
  function throwingMux(message: string): Multiplexer {
    return {
      kind: "tmux",
      open: vi.fn().mockRejectedValue(new Error(message)),
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
  }

  it("redacts a token-bearing cause when mux.open() fails", async () => {
    const io = makeIo();
    const mux = throwingMux(
      "Command failed: tmux send-keys ... JARVIS_MCP_TOKEN=jst_supersecret codex --sandbox read-only"
    );
    const engine = new CliChatEngineImpl("openai-compatible", "codex-fail", io, { mux });

    let caught: unknown;
    try {
      await engine.launch({
        neutralDir: "/tmp/neutral",
        personaPath: "/tmp/persona.txt",
        mcpToken: "jst_supersecret",
        mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliChatUnavailableError);
    const cause = (caught as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(Error);
    const causeMsg = (cause as Error).message;
    // The token must NOT survive into the cause that gets logged server-side.
    expect(causeMsg).not.toContain("jst_supersecret");
    expect(causeMsg).not.toContain("JARVIS_MCP_TOKEN=jst_");
    expect(causeMsg).toContain("[redacted]");
    // The original stack (which can also embed the launch line) is dropped.
    expect((cause as Error).stack).toBeUndefined();
  });
});

// ─── #342 cli-runner path: personaText write + server-side replay-drain ──────────
describe("CliChatEngineImpl — #342 personaText + server-owned drain", () => {
  it("writes the persona FILE from personaText (0600) and points the CLI at it", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "rpc-session", io, { ownsDrain: true });
    await engine.launch({
      neutralDir: "/data/cli-auth/chat/user-1",
      // personaPath is ignored when personaText is present (the server writes the file).
      personaPath: "/data/cli-auth/chat/user-1/persona.md",
      personaText: "You are Jarvis.",
      mcpToken: "jst_x",
      mcpServerUrl: "http://api:3000/api/mcp"
    });

    const personaWrite = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).endsWith("/persona.md")
    );
    expect(personaWrite).toBeDefined();
    expect(personaWrite![1]).toBe("You are Jarvis.");
    expect(io.run).toHaveBeenCalledWith("chmod", ["600", "/data/cli-auth/chat/user-1/persona.md"]);

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain("--append-system-prompt-file");
    expect(launchLine).toContain("/data/cli-auth/chat/user-1/persona.md");
  });

  it("returns offset 0 when no replayBatch is given (fresh conversation)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "rpc-fresh", io, { ownsDrain: true });
    const res = await engine.launch({
      neutralDir: "/data/cli-auth/chat/user-2",
      personaPath: "/data/cli-auth/chat/user-2/persona.md",
      personaText: "You are Jarvis."
    });
    expect(res).toEqual({ offset: 0 });
  });

  it("submits the replayBatch and drains to the post-replay offset (§4.1.2)", async () => {
    const io = makeIo();
    let transcript = "";
    const replay = "prior conversation here";
    const mux = stateMachineMux({
      panes: ["❯\n", `❯ ${replay}\n`],
      onEnter: () => {
        transcript = [
          claudeUser(replay).trimEnd(),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn"
            }
          })
        ].join("\n");
      }
    });
    io.readFile.mockImplementation(async () => transcript);

    const engine = new CliChatEngineImpl("anthropic", "rpc-replay", io, {
      ownsDrain: true,
      drainMs: 2_000,
      drainPollMs: 1,
      echoMs: 0,
      mux
    });
    const res = await engine.launch({
      neutralDir: "/data/cli-auth/chat/user-3",
      personaPath: "/data/cli-auth/chat/user-3/persona.md",
      personaText: "You are Jarvis.",
      replayBatch: replay,
      replayAttemptId: "66666666-6666-4666-8666-666666666666"
    });

    expect(mux.paste).toHaveBeenCalledWith("pane-1", replay);
    // Drained to the end of the transcript (non-zero, the replay block consumed).
    expect(res.offset).toBe(transcript.length);
    expect(res.offset).toBeGreaterThan(0);
  });

  it("fails launch when replay is ACKED but never completes", async () => {
    const io = makeIo();
    let transcript = "";
    const replay = "prior conversation here";
    const mux = stateMachineMux({
      panes: ["❯\n", `❯ ${replay}\n`],
      onEnter: () => {
        transcript = claudeUser(replay);
      }
    });
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "rpc-replay-incomplete", io, {
      ownsDrain: true,
      drainMs: 0,
      echoMs: 0,
      mux
    });

    await expect(
      engine.launch({
        neutralDir: "/data/cli-auth/chat/user-incomplete",
        personaPath: "/data/cli-auth/chat/user-incomplete/persona.md",
        personaText: "You are Jarvis.",
        replayBatch: replay,
        replayAttemptId: "77777777-7777-4777-8777-777777777777"
      })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
    expect(mux.kill).toHaveBeenCalledTimes(1);
  });
});

// ─── #342 module-level mux-name operations (§4.5 / §4.6) ─────────────────────────
describe("cli-runner mux-name helpers", () => {
  it("killMuxSessionByName kills the canonical jarv1s-live-<key> session by EXACT name", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await killMuxSessionByName({ run }, "user-42");
    // SECURITY: the leading `=` forces tmux to match the EXACT session name, not a
    // prefix — without it `jarv1s-live-user-4` could also reap `jarv1s-live-user-42`.
    // #1142: raw tmux verbs are now pinned to a private `-S <socket>` server, so the
    // verb/target follow the socket flag — assert positionally, not the whole array.
    const [cmd, args] = run.mock.calls[0]! as [string, string[]];
    expect(cmd).toBe("tmux");
    expect(args.slice(0, 2)).toEqual(["-S", expect.any(String)]);
    expect(args.slice(2)).toEqual(["kill-session", "-t", `=${SESSION_PREFIX}user-42`]);
  });

  it("killMuxSessionByName uses the `=` EXACT-name target so a prefix key never over-reaps (§4.5 security)", async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    // `bob` is a strict prefix of `bobby`. The kill for `bob` must target ONLY
    // `jarv1s-live-bob`, never the longer `jarv1s-live-bobby`.
    await killMuxSessionByName({ run }, "bob");
    // #1142: `-t` target now follows the `-S <socket>` prefix, so locate it by flag.
    const killArgs = run.mock.calls[0]![1] as string[];
    const target = killArgs[killArgs.indexOf("-t") + 1]!;
    expect(target).toBe(`=${SESSION_PREFIX}bob`);
    // The `=` prefix is what tmux requires for exact (non-prefix) target resolution.
    expect(target.startsWith("=")).toBe(true);
    // It must NOT be the bare name (which tmux resolves as a PREFIX match).
    expect(target).not.toBe(`${SESSION_PREFIX}bob`);
  });

  it("listLiveMuxSessions enumerates by mux and strips the prefix (§4.6)", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: `${SESSION_PREFIX}alice\n${SESSION_PREFIX}bob\nsome-other-session\n`,
      stderr: ""
    });
    const keys = await listLiveMuxSessions({ run });
    expect(keys).toEqual(["alice", "bob"]);
  });

  it("listLiveMuxSessions tolerates 'no tmux server' (nonzero exit → empty)", async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "no server" });
    expect(await listLiveMuxSessions({ run })).toEqual([]);
  });

  it("deriveNeutralDir joins under the base; sanitizeSessionKey rejects traversal", () => {
    expect(deriveNeutralDir("/data/cli-auth/chat", "user-1")).toBe("/data/cli-auth/chat/user-1");
    expect(() => sanitizeSessionKey("../escape")).toThrow();
    expect(() => sanitizeSessionKey("a/b")).toThrow();
    expect(() => sanitizeSessionKey("")).toThrow();
    expect(sanitizeSessionKey("ok-uuid-123")).toBe("ok-uuid-123");
  });
});
