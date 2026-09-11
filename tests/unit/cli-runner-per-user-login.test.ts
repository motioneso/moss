import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { LOGIN_ADAPTERS } from "../../packages/cli-runner/src/login-adapters.js";
import { LoginBadRequestError, LoginService } from "../../packages/cli-runner/src/login-service.js";
import { LOGIN_SESSION_PREFIX } from "../../packages/chat/src/live/login-mux-sessions.js";

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

  it("uses the same isolated home and owner uid for the probe and login process", async () => {
    const { io } = loginIo();
    const homeBase = await mkdtemp(join(tmpdir(), "per-user-login-"));
    let probedHome: string | undefined;
    const userHome = join(homeBase, "agents", "user-a");
    const service = new LoginService({
      io,
      homeBase,
      adapters: LOGIN_ADAPTERS,
      resolveUserRuntime: async (userId) => ({
        userId,
        homeBase: userHome,
        uid: 100001,
        gid: 100001,
        io
      }),
      probe: async (_provider, opts) => {
        probedHome = opts?.runtime?.homeBase;
        return { status: "needs_login" };
      },
      settleMs: 0
    });
    const loginId = service.reserve("anthropic", "user-a");
    await service.start(loginId);
    expect(probedHome).toBe(userHome);
    await service.cancel("anthropic", loginId, "user-a");
  });
});
