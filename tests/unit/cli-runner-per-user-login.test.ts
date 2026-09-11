import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { LOGIN_ADAPTERS } from "../../packages/cli-runner/src/login-adapters.js";
import { LoginBadRequestError, LoginService } from "../../packages/cli-runner/src/login-service.js";
import { LOGIN_SESSION_PREFIX } from "../../packages/chat/src/live/login-mux-sessions.js";
import { clearProviderProbeCacheForTests } from "../../packages/chat/src/live/provider-probe.js";

function loginIo(): { io: TmuxIo; live: Set<string> } {
  const live = new Set<string>();
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    if (command !== "tmux") return { code: 0, stdout: "", stderr: "" };
    const verb = args[0] === "-S" ? args[2] : args[0];
    if (verb === "new-session") {
      live.add(args[args.indexOf("-s") + 1]!);
    } else if (verb === "list-sessions") {
      return { code: 0, stdout: [...live].join("\n"), stderr: "" };
    } else if (verb === "kill-session") {
      live.delete(args[args.indexOf("-t") + 1]!.replace(/^=/, ""));
    } else if (verb === "capture-pane") {
      return { code: 0, stdout: "https://claude.ai/oauth/authorize?code=abc", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  return {
    io: {
      run: run as unknown as TmuxIo["run"],
      sleep: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined)
    },
    live
  };
}

describe("per-user Codex login boundaries", () => {
  it("rejects cross-user flow operations and keeps the owner session alive", async () => {
    const { io, live } = loginIo();
    const homeBase = await mkdtemp(join(tmpdir(), "per-user-login-"));
    const service = new LoginService({
      io,
      homeBase,
      adapters: LOGIN_ADAPTERS,
      probe: async () => ({ status: "needs_login" }),
      settleMs: 0
    });
    const loginId = service.reserve("anthropic", "user-a");
    await service.start(loginId);
    expect(live.has(`${LOGIN_SESSION_PREFIX}user-a-anthropic`)).toBe(true);
    await expect(service.poll("anthropic", loginId, "user-b")).rejects.toBeInstanceOf(
      LoginBadRequestError
    );
    await expect(
      service.submitToken("anthropic", loginId, "secret", "user-b")
    ).rejects.toBeInstanceOf(LoginBadRequestError);
    await service.cancel("anthropic", loginId, "user-b");
    expect(live.has(`${LOGIN_SESSION_PREFIX}user-a-anthropic`)).toBe(true);
    await service.cancel("anthropic", loginId, "user-a");
    expect(live.has(`${LOGIN_SESSION_PREFIX}user-a-anthropic`)).toBe(false);
  });

  it("uses the isolated home and owner uid for Codex probe and login process", async () => {
    const { io } = loginIo();
    const homeBase = await mkdtemp(join(tmpdir(), "per-user-login-"));
    let probedHome: string | undefined;
    const userHome = join(homeBase, "agents", "user-a");
    const service = new LoginService({
      io,
      homeBase,
      adapters: LOGIN_ADAPTERS,
      resolveUserRuntime: async (provider, userId) => {
        expect(provider).toBe("openai-compatible");
        return {
          userId,
          homeBase: userHome,
          uid: 100001,
          gid: 100001,
          io
        };
      },
      probe: async (_provider, opts) => {
        probedHome = opts?.runtime?.homeBase;
        return { status: "needs_login" };
      },
      settleMs: 0
    });
    const loginId = service.reserve("openai-compatible", "user-a");
    await service.start(loginId);
    expect(probedHome).toBe(userHome);
    await service.cancel("openai-compatible", loginId, "user-a");
  });

  it("keeps non-Codex probe and rejection scope shared", async () => {
    const { io } = loginIo();
    const resolved: string[] = [];
    const probeRun = vi.fn(async (command: string) => {
      if (command === "claude" || command === "gemini") {
        return { code: 0, stdout: "OK", stderr: "" };
      }
      if (command === "codex") return { code: 0, stdout: "Logged in", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const hostIo: TmuxIo = {
      ...io,
      run: probeRun as unknown as TmuxIo["run"]
    };
    const host = new CliChatEngineHost({
      io: hostIo,
      homeBase: await mkdtemp(join(tmpdir(), "shared-login-")),
      neutralBase: await mkdtemp(join(tmpdir(), "shared-login-neutral-")),
      singleUser: false,
      resolveUserRuntime: async (userId) => {
        resolved.push(userId);
        return { userId, homeBase: "/isolated", uid: 100001, gid: 100001, io: hostIo };
      },
      cliPresent: async () => true
    });

    clearProviderProbeCacheForTests();
    expect(await host.probeProvider("anthropic", "user-a", { forceFresh: true })).toMatchObject({
      status: "ready"
    });
    await host.recordLoginRejected("anthropic", "user-a");
    expect(await host.probeProvider("anthropic", "user-a")).toMatchObject({
      status: "needs_login"
    });
    expect(await host.probeProvider("anthropic", "user-b")).toMatchObject({
      status: "needs_login"
    });
    expect(await host.probeProvider("anthropic", "user-a", { forceFresh: true })).toMatchObject({
      status: "ready"
    });

    expect(await host.probeProvider("google", "user-a", { forceFresh: true })).toMatchObject({
      status: "ready"
    });
    await host.recordLoginRejected("google", "user-a");
    expect(await host.probeProvider("google", "user-b")).toMatchObject({
      status: "needs_login"
    });
    expect(await host.probeProvider("google", "user-a", { forceFresh: true })).toMatchObject({
      status: "ready"
    });

    await host.probeProvider("openai-compatible", "user-a", { forceFresh: true });
    await host.recordLoginRejected("openai-compatible", "user-a");

    expect(resolved).toEqual(["user-a", "user-a"]);
  });
});
