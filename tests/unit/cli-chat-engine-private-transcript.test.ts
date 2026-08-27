import { describe, expect, it, vi } from "vitest";

import { CliChatEngineImpl } from "../../packages/chat/src/live/cli-chat-engine.js";
import {
  CODEX_IDENTITY_FILENAME,
  codexTranscriptPath
} from "../../packages/chat/src/live/private-transcript-cleanup.js";

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

describe("CliChatEngineImpl — Claude MCP lockdown", () => {
  it("uses --allowedTools mcp__jarvis__* and the mcp-config PATH (token off the launch line)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "test-session", io);
    const launched = await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });

    // launch() now returns the post-drain offset (§4.0); the in-process engine does not
    // own the drain, so it returns { offset: 0 }.
    expect(launched).toEqual({ offset: 0 });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    expect(sendKeysCall).toBeDefined();
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain("--allowedTools");
    expect(launchLine).toContain("mcp__jarvis__*");
    expect(launchLine).not.toContain('--tools ""');
    // §6.2: the launch line carries the mcp-config FILE PATH, never the token/JSON.
    expect(launchLine).toContain(".jarvis-claude-mcp.json");
    expect(launchLine).toContain("--settings '/tmp/neutral/.jarvis-claude-settings.json'");
    expect(launchLine).not.toContain("jst_abc");
    expect(launchLine).not.toContain("Bearer");
    expect(launchLine).not.toContain("Authorization");
    // #1071 (revert of #1068): default mode. Seeding + correct HOME suppress the trust wizard;
    // bypassPermissions triggers a blocking accept-warning that wedges the REPL → 503. Tool safety
    // here comes from --allowedTools + the PreToolUse hook (below), independent of --permission-mode.
    expect(launchLine).toContain("--permission-mode default");
    expect(launchLine).toContain("--strict-mcp-config");
    expect(launchLine).not.toContain("web_search");
    expect(launchLine).not.toContain("browser");
    expect(launchLine).not.toContain("browse");

    // The token + url live ONLY in the 0600 .jarvis-claude-mcp.json file (§6.2/§6.5).
    const mcpWrite = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) =>
      String(c[0]).endsWith(".jarvis-claude-mcp.json")
    );
    expect(mcpWrite).toBeDefined();
    expect(mcpWrite![1]).toContain("jst_abc");
    expect(io.run).toHaveBeenCalledWith("chmod", ["600", "/tmp/neutral/.jarvis-claude-mcp.json"]);
    const permissionTokenWrite = (io.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => String(c[0]).endsWith(".jarvis-claude-permission-token")
    );
    expect(permissionTokenWrite).toEqual([
      "/tmp/neutral/.jarvis-claude-permission-token",
      "jst_abc\n"
    ]);
    expect(io.run).toHaveBeenCalledWith("chmod", [
      "600",
      "/tmp/neutral/.jarvis-claude-permission-token"
    ]);
  });

  it("removes the entire per-session neutral dir on kill (§6.5)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "kill-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral-kill",
      personaPath: "/tmp/persona.txt",
      mcpToken: "jst_abc",
      mcpServerUrl: "http://127.0.0.1:3000/api/mcp"
    });
    await engine.kill();
    // The whole dir is removed (covers the Claude mcp-config file + persona), not one file.
    expect(io.run).toHaveBeenCalledWith("rm", ["-rf", "/tmp/neutral-kill"]);
  });

  it("purgeTranscripts removes Claude's per-session transcript directory", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "private-claude", io, {
      homeBase: "/host-home"
    });
    await engine.launch({
      neutralDir: "/tmp/private-neutral",
      personaPath: "/tmp/persona.txt"
    });

    await engine.purgeTranscripts();

    expect(io.run).toHaveBeenCalledWith("rm", [
      "-rf",
      "/host-home/.claude/projects/-tmp-private-neutral"
    ]);
  });

  it("purgeTranscripts removes only the exact marker-named Codex session", async () => {
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    const io = makeCodexIo(uuid);
    const neutralDir = "/tmp/private-neutral";
    const transcriptPath = codexTranscriptPath(uuid, "/host-home");
    const engine = new CliChatEngineImpl("openai-compatible", "private-codex", io, {
      homeBase: "/host-home"
    });
    await engine.launch({
      neutralDir,
      personaPath: "/tmp/persona.txt"
    });

    io.run.mockImplementation(async (cmd: string) => ({
      code: 0,
      stdout: cmd === "find" ? `${transcriptPath}\n` : "",
      stderr: ""
    }));
    io.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith(CODEX_IDENTITY_FILENAME)) return `${uuid}\n`;
      return JSON.stringify({
        type: "session_meta",
        payload: { id: uuid, cwd: neutralDir, timestamp: new Date().toISOString() }
      });
    });

    await engine.purgeTranscripts();

    const rmCalls = io.run.mock.calls.filter((call: unknown[]) => call[0] === "rm");
    expect(rmCalls).toContainEqual(["rm", ["-f", transcriptPath]]);
    expect(io.run.mock.calls.some((call: unknown[]) => call[0] === "ls")).toBe(false);
  });

  it("passes --model <id> on the claude launch line for a concrete model override (#367)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "model-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      model: "sonnet"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain("--model 'sonnet'");
  });

  it("omits --model for the 'default' sentinel — rides claude's interactive/account model (#367)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "default-model-session", io);
    await engine.launch({
      neutralDir: "/tmp/neutral",
      personaPath: "/tmp/persona.txt",
      model: "default"
    });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("--model");
  });

  it("omits --model when no model is set (rides the account default) (#367)", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "no-model-session", io);
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).not.toContain("--model");
  });

  // #367: the omit-for-'default' / pass-for-concrete rule is UNIFORM across all three CLIs.
  it.each(["openai-compatible", "google"] as const)(
    "passes --model for a concrete override on %s (#367)",
    async (provider) => {
      const io = provider === "google" ? makeGeminiIo() : makeCodexIo();
      const engine = new CliChatEngineImpl(provider, `${provider}-concrete-session`, io);
      await engine.launch({
        neutralDir: "/tmp/neutral",
        personaPath: "/tmp/persona.txt",
        model: "some-concrete-model"
      });

      const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
      );
      const launchLine = (() => {
        const a = sendKeysCall![1] as string[];
        return a[a.indexOf("-t") + 2];
      })();
      expect(launchLine).toContain("--model 'some-concrete-model'");
    }
  );

  it.each(["openai-compatible", "google"] as const)(
    "omits --model for the 'default' sentinel on %s (#367)",
    async (provider) => {
      const io = provider === "google" ? makeGeminiIo() : makeCodexIo();
      const engine = new CliChatEngineImpl(provider, `${provider}-default-session`, io);
      await engine.launch({
        neutralDir: "/tmp/neutral",
        personaPath: "/tmp/persona.txt",
        model: "default"
      });

      const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
        (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
      );
      const launchLine = (() => {
        const a = sendKeysCall![1] as string[];
        return a[a.indexOf("-t") + 2];
      })();
      expect(launchLine).not.toContain("--model");
    }
  );

  it("falls back to --tools '' when no mcpToken is provided", async () => {
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "test-session", io);
    await engine.launch({ neutralDir: "/tmp/neutral", personaPath: "/tmp/persona.txt" });

    const sendKeysCall = (io.run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "tmux" && (c[1] as string[]).includes("send-keys")
    );
    const launchLine = (() => {
      const a = sendKeysCall![1] as string[];
      return a[a.indexOf("-t") + 2];
    })();
    expect(launchLine).toContain('--tools ""');
    expect(launchLine).not.toContain("--allowedTools");
    // #1071 (revert of #1068): default mode. Seeding + correct HOME suppress the trust wizard;
    // bypassPermissions triggers a blocking accept-warning that wedges the REPL → 503. On this branch
    // native tools are fully disabled by --tools "" above, independent of --permission-mode.
    expect(launchLine).toContain("--permission-mode default");
    expect(launchLine).toContain("--strict-mcp-config");
    expect(launchLine).not.toContain("web_search");
    expect(launchLine).not.toContain("browser");
    expect(launchLine).not.toContain("browse");
  });
});
