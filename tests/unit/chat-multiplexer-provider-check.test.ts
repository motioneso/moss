import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeProviderConnectionCheckProbe } from "../../packages/module-registry/src/chat-multiplexer.js";
import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";

describe("makeProviderConnectionCheckProbe", () => {
  it("gives the real provider check an isolated HOME without ambient secrets", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "jarv1s-provider-bin-"));
    const capturePath = join(fakeBin, "delivered-env");
    await writeFile(
      join(fakeBin, "claude"),
      `#!/bin/sh\n/usr/bin/env > "${capturePath}"\nprintf '{"loggedIn":true}\\n'\n`,
      { mode: 0o755 }
    );
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("anthropic provider checks should not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      env: {
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin"}`,
        HOME: "/real-user-home",
        BETTER_AUTH_SECRET: "must-not-reach-provider"
      }
    });

    try {
      await expect(probe("anthropic")).resolves.toEqual({ status: "ready" });
      const delivered = Object.fromEntries(
        (await readFile(capturePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => line.split(/=(.*)/s, 2))
      );
      expect(delivered.HOME?.startsWith(join(tmpdir(), "jarv1s-provider-check-"))).toBe(true);
      expect(delivered.BETTER_AUTH_SECRET).toBeUndefined();
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  it("checks Claude with claude auth status instead of opening an interactive engine", async () => {
    const runs: Array<{ cmd: string; args: readonly string[] }> = [];
    const commandIo = {
      run: async (cmd, args) => {
        runs.push({ cmd, args });
        return { code: 0, stdout: JSON.stringify({ loggedIn: true }) };
      }
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("anthropic provider checks should not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    const result = await probe("anthropic");

    expect(result).toEqual({ status: "ready" });
    expect(runs).toEqual([{ cmd: "claude", args: ["auth", "status"] }]);
  });

  it("treats logged-out Claude auth status as needing login", async () => {
    const commandIo = {
      run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) })
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("anthropic provider checks should not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    await expect(probe("anthropic")).resolves.toEqual({ status: "needs_login" });
  });

  it("checks Codex with codex login status instead of opening an interactive engine", async () => {
    const runs: Array<{ cmd: string; args: readonly string[] }> = [];
    const commandIo = {
      run: async (cmd, args) => {
        runs.push({ cmd, args });
        return { code: 0, stdout: "Logged in using ChatGPT\n" };
      }
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("codex provider checks should not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    const result = await probe("openai-compatible");

    expect(result).toEqual({ status: "ready" });
    expect(runs).toEqual([{ cmd: "codex", args: ["login", "status"] }]);
  });

  it("treats logged-out Codex login status as needing login", async () => {
    const commandIo = {
      run: async () => ({ code: 1, stdout: "Not logged in\n" })
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("codex provider checks should not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    await expect(probe("openai-compatible")).resolves.toEqual({ status: "needs_login" });
  });

  it("checks Google by asking the real Gemini command for a one-word answer", async () => {
    const runs: Array<{ cmd: string; args: readonly string[] }> = [];
    const commandIo = {
      run: async (cmd: string, args: readonly string[]) => {
        runs.push({ cmd, args });
        return { code: 0, stdout: "OK\n", stderr: "" };
      }
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("google checks must not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    const result = await probe("google");

    expect(result).toEqual({ status: "ready" });
    expect(runs).toEqual([{ cmd: "gemini", args: ["--prompt", "Reply with exactly OK."] }]);
  });

  it("accepts an answer the model dressed up with quotes or a full stop", async () => {
    const commandIo = {
      run: async () => ({ code: 0, stdout: '"Okay."\n', stderr: "" })
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("google checks must not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    await expect(probe("google")).resolves.toEqual({ status: "ready" });
  });

  it("treats a Google sign-in message as needing login", async () => {
    const commandIo = {
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "Please sign in to continue\n"
      })
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("google checks must not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    await expect(probe("google")).resolves.toEqual({ status: "needs_login" });
  });

  it("treats a non-auth Google crash as error, not needs_login", async () => {
    const commandIo = {
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "Fatal: gemini crashed (segfault)\n"
      })
    } satisfies Pick<TmuxIo, "run">;
    const probe = makeProviderConnectionCheckProbe({
      engineFactory: () => {
        throw new Error("google checks must not open an interactive engine");
      },
      cliPresent: async () => true,
      skipInstallCheck: true,
      commandIo
    });

    await expect(probe("google")).resolves.toEqual({ status: "error" });
  });
});
