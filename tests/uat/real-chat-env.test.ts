import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn<(...args: unknown[]) => string>();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args)
}));

const existsSyncMock = vi.fn<(path: string) => boolean>();
const readFileSyncMock = vi.fn<(path: string) => Buffer>();
vi.mock("node:fs", () => ({
  existsSync: (path: string) => existsSyncMock(path),
  readFileSync: (path: string) => readFileSyncMock(path)
}));

const readSavedClaudeTokenMock = vi.fn<() => string | undefined>();
const saveClaudeTokenMock = vi.fn<(token: string) => void>();
vi.mock("./claude-signin-handoff.js", () => ({
  CLAUDE_TOKEN_REUSED_ENV: "JARVIS_UAT_CLAUDE_TOKEN_REUSED",
  readSavedClaudeToken: () => readSavedClaudeTokenMock(),
  saveClaudeToken: (token: string) => saveClaudeTokenMock(token)
}));

const {
  installUatRealChatAuth,
  installUatRealChatCodexAuth,
  hostCodexAuthPath,
  uatRealChatProvider,
  uatRealChatProviderKind
} = await import("./real-chat-env.js");

const SECRET = Buffer.from('{"token":"super-secret-value"}');

function buildComposeArgs(extra: readonly string[]): readonly string[] {
  return ["compose", "-p", "uat-test", ...extra];
}

describe("installUatRealChatCodexAuth (#2732)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE;
  });

  it("is a no-op when the host has no Codex login file", () => {
    existsSyncMock.mockReturnValue(false);
    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);
    expect(result).toBeUndefined();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("copies the host auth file over stdin and never puts its content in an argv", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n") // stat owner
      .mockReturnValueOnce(
        JSON.stringify({ uid: 100_001, gid: 100_001, home: "/data/cli-auth/agents/actor-1" })
      ) // uid slot
      .mockReturnValueOnce("") // chown
      .mockReturnValueOnce(""); // write auth.json

    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);

    expect(result).toBeDefined();
    expect(execFileSyncMock).toHaveBeenCalledTimes(4);
    for (const call of execFileSyncMock.mock.calls) {
      const [, args, options] = call as [string, readonly string[], { input?: Buffer }];
      expect(args.join(" ")).not.toContain("super-secret-value");
      if (options?.input) {
        expect(options.input).toBe(SECRET);
      }
    }
  });

  it("cleanup removes both the owner-scoped slot copy and the shared instance copy it may have been promoted to (#2732 P1-1)", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce(
        JSON.stringify({ uid: 100_001, gid: 100_001, home: "/data/cli-auth/agents/actor-1" })
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("") // rm owner-scoped slot copy
      .mockReturnValueOnce(""); // rm shared instance copy + any leftover temp file

    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    const [ownerRmCall, sharedRmCall] = execFileSyncMock.mock.calls.slice(-2) as [
      [string, readonly string[]],
      [string, readonly string[]]
    ];
    expect(ownerRmCall[1]).toContain("/data/cli-auth/agents/actor-1/.codex/auth.json");
    expect(ownerRmCall[1]).toContain("rm");
    // The shared copy lives outside every user's home, at the instance's own auth path — the
    // same file main.ts's onLoginReady promotes an already-authenticated sign-in into.
    expect(sharedRmCall[1].join(" ")).toContain("/data/cli-auth/.codex/auth.json");
    expect(sharedRmCall[1].join(" ")).toContain("/data/cli-auth/.codex/.auth.json.*.tmp");
  });

  it("still attempts the shared instance copy's removal when the owner-scoped removal fails, then fails loudly with no credential text", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce(
        JSON.stringify({ uid: 100_001, gid: 100_001, home: "/data/cli-auth/agents/actor-1" })
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => {
        // Simulates the owner-scoped copy's own removal failing, e.g. because the container
        // already exited — a setup-time-shaped failure, not a credential-content one.
        throw new Error("container already exited");
      })
      .mockReturnValueOnce(""); // the shared instance copy's removal still runs and succeeds

    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);
    await expect(result!.cleanup()).rejects.toThrow(/credential cleanup failed for uat-test/);

    const sharedRmCall = execFileSyncMock.mock.calls.at(-1) as [string, readonly string[]];
    expect(sharedRmCall[1].join(" ")).toContain("/data/cli-auth/.codex/auth.json");
    expect(
      execFileSyncMock.mock.calls.every(
        ([, args]) => !(args as readonly string[]).join(" ").includes(SECRET.toString("utf8"))
      )
    ).toBe(true);
  });

  it("throws loudly (never a silent skip) when the owner-scoped copy fails", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce(
        JSON.stringify({ uid: 100_001, gid: 100_001, home: "/data/cli-auth/agents/actor-1" })
      )
      .mockReturnValueOnce("")
      .mockImplementationOnce(() => {
        throw new Error("write failed");
      });

    expect(() => installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs)).toThrow(
      /owner-scoped Codex credential copy failed/
    );
  });

  it("defaults to ~/.codex/auth.json, overridable for testing via an env var", () => {
    expect(hostCodexAuthPath()).toMatch(/\.codex\/auth\.json$/);
    process.env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE = "/tmp/custom-auth.json";
    expect(hostCodexAuthPath()).toBe("/tmp/custom-auth.json");
  });
});

describe("installUatRealChatAuth provider choice (#3361)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.JARVIS_UAT_REAL_CHAT_PROVIDER;
    delete process.env.JARVIS_UAT_REAL_CHAT_CODEX_AUTH_FILE;
    process.env.MOSS_UAT_CAPTURE_OFF = "1";
  });

  afterEach(() => {
    delete process.env.MOSS_UAT_CAPTURE_OFF;
  });

  it("refuses Claude while captures are on, because a kept trace records the sign-in code", () => {
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    delete process.env.MOSS_UAT_CAPTURE_OFF;
    expect(() => uatRealChatProvider()).toThrow(/needs MOSS_UAT_CAPTURE_OFF=1/);
    expect(() => installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs)).toThrow(
      /needs MOSS_UAT_CAPTURE_OFF=1/
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "codex";
    expect(uatRealChatProvider()).toBe("codex");
  });

  it("defaults to Codex and rejects an unknown provider", () => {
    expect(uatRealChatProvider()).toBe("codex");
    expect(uatRealChatProviderKind()).toBe("openai-compatible");
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    expect(uatRealChatProvider()).toBe("claude");
    expect(uatRealChatProviderKind()).toBe("anthropic");
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "gemini";
    expect(() => uatRealChatProvider()).toThrow(/must be "codex" or "claude"/);
  });

  it("keeps the Codex host-login copy when Codex is selected", () => {
    existsSyncMock.mockReturnValue(false);
    expect(installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs)).toBeUndefined();
    expect(existsSyncMock).toHaveBeenCalledWith(hostCodexAuthPath());
  });

  it("with Claude selected, copies no host login into the stack", () => {
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock.mockReturnValueOnce("1000:1000\n");

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);

    expect(result).toBeDefined();
    expect(readFileSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    for (const call of execFileSyncMock.mock.calls) {
      const [, args, options] = call as [string, readonly string[], { input?: Buffer }];
      expect(options?.input).toBeUndefined();
      expect(args.join(" ")).not.toMatch(/\.codex|\.claude/);
    }
  });

  it("with Claude selected, cleanup removes the minted token from the instance and agent homes", async () => {
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n") // cli-auth owner
      .mockImplementationOnce(() => {
        throw new Error("no token minted"); // read instance token to keep
      })
      .mockReturnValueOnce("") // rm instance token
      .mockReturnValueOnce("100001:100001\n") // agent home owner
      .mockReturnValueOnce(""); // rm agent token

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();
    await result!.cleanup();

    const calls = execFileSyncMock.mock.calls as [string, readonly string[]][];
    expect(calls).toHaveLength(5);
    const [, , instanceRm, , agentRm] = calls.map(([, args]) => args.join(" "));
    expect(instanceRm).toContain("--user 1000:1000");
    expect(instanceRm).toContain("/data/cli-auth/.jarvis/cli-tokens/anthropic");
    expect(instanceRm).toContain("/data/cli-auth/.jarvis/cli-tokens/anthropic.tmp");
    expect(agentRm).toContain("--user 100001:100001");
    expect(agentRm).toContain("/data/cli-auth/agents/actor-1/.jarvis/cli-tokens/anthropic");
  });

  it("with Claude selected, a failed token removal fails loudly", async () => {
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockImplementationOnce(() => {
        throw new Error("container already exited");
      })
      .mockImplementationOnce(() => {
        throw new Error("container already exited");
      })
      .mockImplementationOnce(() => {
        throw new Error("no agent home");
      });

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await expect(result!.cleanup()).rejects.toThrow(/Claude token cleanup failed for uat-test/);
  });
});

describe("installUatRealChatAuth saved Claude sign-in (#3387)", () => {
  const SEEDED = `sk-ant-oat01-${"a".repeat(40)}`;
  const MINTED = `sk-ant-oat01-${"b".repeat(40)}`;
  const INSTANCE_TOKEN = "/data/cli-auth/.jarvis/cli-tokens/anthropic";
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.JARVIS_UAT_REAL_CHAT_PROVIDER = "claude";
    process.env.MOSS_UAT_CAPTURE_OFF = "1";
    process.env.JARVIS_UAT_CLAUDE_TOKEN_REUSED = "stale from an earlier stack";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.JARVIS_UAT_REAL_CHAT_PROVIDER;
    delete process.env.MOSS_UAT_CAPTURE_OFF;
    delete process.env.JARVIS_UAT_CLAUDE_TOKEN_REUSED;
    logSpy.mockRestore();
  });

  const calls = () =>
    execFileSyncMock.mock.calls as [string, readonly string[], { input?: Buffer }][];
  const logged = () => logSpy.mock.calls.flat().join("\n");

  it("seeds the saved token into the instance home over stdin and tells the spec", () => {
    readSavedClaudeTokenMock.mockReturnValue(SEEDED);
    execFileSyncMock.mockReturnValueOnce("1000:1000\n").mockReturnValueOnce("");

    installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);

    expect(calls()).toHaveLength(2);
    const [, args, options] = calls()[1]!;
    expect(options.input?.toString("utf8")).toBe(SEEDED);
    expect(args).toContain("--user");
    expect(args).toContain("1000:1000");
    expect(args.at(-1)).toBe(INSTANCE_TOKEN);
    expect(args.join(" ")).not.toContain(SEEDED);
    expect(process.env.JARVIS_UAT_CLAUDE_TOKEN_REUSED).toBe("1");
    expect(logged()).not.toContain(SEEDED);
  });

  it("with no saved token seeds nothing and clears an earlier stack's signal", () => {
    readSavedClaudeTokenMock.mockReturnValue(undefined);
    execFileSyncMock.mockReturnValueOnce("1000:1000\n");

    installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);

    expect(calls()).toHaveLength(1);
    expect(process.env.JARVIS_UAT_CLAUDE_TOKEN_REUSED).toBeUndefined();
  });

  it("falls back to a link, without the reuse signal, when seeding fails", () => {
    readSavedClaudeTokenMock.mockReturnValue(SEEDED);
    execFileSyncMock.mockReturnValueOnce("1000:1000\n").mockImplementationOnce(() => {
      throw new Error(`exec failed near ${SEEDED}`);
    });

    expect(() => installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs)).not.toThrow();
    expect(process.env.JARVIS_UAT_CLAUDE_TOKEN_REUSED).toBeUndefined();
    expect(logged()).toContain("will ask for a link");
    expect(logged()).not.toContain(SEEDED);
  });

  it("cleanup saves a token this run minted, before removing it from the stack", async () => {
    readSavedClaudeTokenMock.mockReturnValue(undefined);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n") // cli-auth owner
      .mockReturnValueOnce(`${MINTED}\n`) // read instance token
      .mockReturnValueOnce("") // rm instance token
      .mockImplementationOnce(() => {
        throw new Error("no agent home");
      });

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    expect(saveClaudeTokenMock).toHaveBeenCalledExactlyOnceWith(MINTED);
    const read = calls()[1]![1];
    expect(read.slice(-2)).toEqual(["cat", INSTANCE_TOKEN]);
    expect(read).toContain("1000:1000");
    expect(calls()[2]![1].join(" ")).toContain(`rm -f ${INSTANCE_TOKEN}`);
    expect(logged()).toContain("new Claude sign-in saved");
    expect(logged()).not.toContain(MINTED);
  });

  it("cleanup saves nothing when the stack still holds the seeded token", async () => {
    readSavedClaudeTokenMock.mockReturnValue(SEEDED);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce("") // seed
      .mockReturnValueOnce(SEEDED) // read instance token
      .mockReturnValue("");

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    expect(saveClaudeTokenMock).not.toHaveBeenCalled();
  });

  it("cleanup saves a newly minted token over a refused seeded one", async () => {
    readSavedClaudeTokenMock.mockReturnValue(SEEDED);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce("") // seed
      .mockReturnValueOnce(MINTED) // read instance token
      .mockReturnValue("");

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    expect(saveClaudeTokenMock).toHaveBeenCalledExactlyOnceWith(MINTED);
  });

  it("cleanup never saves something that is not a setup token", async () => {
    readSavedClaudeTokenMock.mockReturnValue(undefined);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce("cat: permission denied")
      .mockReturnValue("");

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    expect(saveClaudeTokenMock).not.toHaveBeenCalled();
  });

  it("cleanup still removes the stack's token when saving it fails, and logs no token", async () => {
    readSavedClaudeTokenMock.mockReturnValue(undefined);
    saveClaudeTokenMock.mockImplementation(() => {
      throw new Error(`disk full writing ${MINTED}`);
    });
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce(MINTED)
      .mockReturnValue("");

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    expect(calls()[2]![1].join(" ")).toContain(`rm -f ${INSTANCE_TOKEN}`);
    expect(logged()).toContain("could not save the new Claude sign-in");
    expect(logged()).not.toContain(MINTED);
  });
});
