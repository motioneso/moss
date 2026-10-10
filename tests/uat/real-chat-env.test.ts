import { beforeEach, describe, expect, it, vi } from "vitest";

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
      .mockReturnValueOnce("") // rm instance token
      .mockReturnValueOnce("100001:100001\n") // agent home owner
      .mockReturnValueOnce(""); // rm agent token

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();
    await result!.cleanup();

    const calls = execFileSyncMock.mock.calls as [string, readonly string[]][];
    expect(calls).toHaveLength(4);
    const [, instanceRm, , agentRm] = calls.map(([, args]) => args.join(" "));
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
        throw new Error("no agent home");
      });

    const result = installUatRealChatAuth("uat-test", "actor-1", buildComposeArgs);
    await expect(result!.cleanup()).rejects.toThrow(/Claude token cleanup failed for uat-test/);
  });
});
