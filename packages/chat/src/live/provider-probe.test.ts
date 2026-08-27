import { afterEach, describe, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";
import { probeProvider } from "./provider-probe.js";

function fakeRealMergeIo(result: { code: number; stdout: string; stderr?: string }) {
  const calls: Array<{ cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const io: Pick<TmuxIo, "run"> = {
    run: async (cmd, args, opts) => {
      const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
      calls.push({ cmd, args, env });
      return result;
    }
  };
  return { io, calls };
}

describe("probeProvider anthropic HOME isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("overrides ambient HOME even when credentialEnv is an empty object (regression proof)", async () => {
    vi.stubEnv("HOME", "/ambient/leak-sentinel");
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: '{"loggedIn":true}' });

    await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: {},
      homeBase: "/isolated/identity"
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.env?.HOME).toBe("/isolated/identity");
  });

  it("delivers credentialEnv token keys alongside the HOME override", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: '{"loggedIn":true}' });

    await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      homeBase: "/isolated/identity"
    });

    expect(calls[0]?.env?.HOME).toBe("/isolated/identity");
    expect(calls[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
  });

  it("passes no env override when neither homeBase nor credentialEnv is supplied", async () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: unknown }> = [];
    const io: Pick<TmuxIo, "run"> = {
      run: async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { code: 0, stdout: '{"loggedIn":true}' };
      }
    };

    await probeProvider("anthropic", { io, cliPresent: async () => true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toBeUndefined();
  });

  it("still parses status correctly with the new env plumbing in place", async () => {
    const { io } = fakeRealMergeIo({ code: 0, stdout: '{"loggedIn":true}' });

    const result = await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok" },
      homeBase: "/isolated/identity"
    });

    expect(result).toEqual({ status: "ready" });
  });
});

describe("probeProvider google readiness check (#2027)", () => {
  it("runs the pinned `gemini` command, not the old `agy --print`", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    const out = await probeProvider("google", { io, cliPresent: async () => true });

    // Login only reports success when this probe returns `ready`. Naming a command the pinned
    // install recipe does not place (`agy`) — or a flag the tool does not have (`--print`) —
    // makes the probe unrunnable, so a user completes the whole browser round trip and is then
    // told sign-in failed.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("gemini");
    expect(calls[0]?.args).toEqual(["--prompt", "Reply with exactly OK."]);
    expect(out).toEqual({ status: "ready" });
  });

  it("reports needs_login when the one-shot cannot answer", async () => {
    const { io } = fakeRealMergeIo({ code: 1, stdout: "", stderr: "not authenticated" });

    expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
      status: "needs_login"
    });
  });
});

describe("probeProvider google: how forgiving the readiness answer is (#2027)", () => {
  // A signed-in tool must not be read as signed out just because the model added a full stop or
  // quoted itself. An empty or unrelated answer must still count as not signed in.
  const ready = ["OK\n", "ok", "OK.\n", '"OK"', "**OK**\n", "Okay\n", " OK \n"];
  for (const stdout of ready) {
    it(`treats ${JSON.stringify(stdout)} as signed in`, async () => {
      const { io } = fakeRealMergeIo({ code: 0, stdout });
      expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
        status: "ready"
      });
    });
  }

  const notReady = ["", "   \n", "I cannot help with that.\n", "Not OK\n"];
  for (const stdout of notReady) {
    it(`treats ${JSON.stringify(stdout)} as not signed in`, async () => {
      const { io } = fakeRealMergeIo({ code: 0, stdout });
      expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
        status: "needs_login"
      });
    });
  }

  it("still reports not signed in when the tool answers OK but exits non-zero", async () => {
    const { io } = fakeRealMergeIo({ code: 1, stdout: "OK\n" });
    expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
      status: "needs_login"
    });
  });
});
