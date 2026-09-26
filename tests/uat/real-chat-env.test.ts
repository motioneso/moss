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

const { installUatRealChatCodexAuth, hostCodexAuthPath } = await import("./real-chat-env.js");

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

  it("removes the copied credential on cleanup, addressed at the allocated slot's home", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(SECRET);
    execFileSyncMock
      .mockReturnValueOnce("1000:1000\n")
      .mockReturnValueOnce(
        JSON.stringify({ uid: 100_001, gid: 100_001, home: "/data/cli-auth/agents/actor-1" })
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce(""); // rm at cleanup

    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);
    await result!.cleanup();

    const rmCall = execFileSyncMock.mock.calls.at(-1) as [string, readonly string[]];
    expect(rmCall[1]).toContain("/data/cli-auth/agents/actor-1/.codex/auth.json");
    expect(rmCall[1]).toContain("rm");
  });

  it("cleanup does not throw even when the underlying command fails (the volume is about to be destroyed anyway)", async () => {
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
        throw new Error("container already exited");
      });

    const result = installUatRealChatCodexAuth("uat-test", "actor-1", buildComposeArgs);
    await expect(result!.cleanup()).resolves.toBeUndefined();
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
