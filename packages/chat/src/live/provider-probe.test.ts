import { afterEach, describe, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";
import {
  clearProviderProbeCacheForTests,
  invalidateProviderProbeCache,
  probeProvider,
  recordProviderLoginRejected
} from "./provider-probe.js";

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
    clearProviderProbeCacheForTests();
  });

  it("overrides ambient HOME even when credentialEnv is an empty object (regression proof)", async () => {
    vi.stubEnv("HOME", "/ambient/leak-sentinel");
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

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
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

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
        return { code: 0, stdout: "OK\n" };
      }
    };

    await probeProvider("anthropic", { io, cliPresent: async () => true });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toBeUndefined();
  });
});

describe("probeProvider anthropic readiness check (#2232)", () => {
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  it("runs a real one-shot claude call, not the old auth-status check", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    const result = await probeProvider("anthropic", { io, cliPresent: async () => true });

    // The old `claude auth status` command only checks that a token FILE is present, never
    // that the token still works, so a stale token used to read as logged in forever.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.args).toEqual(["--print", "Reply with exactly OK."]);
    expect(result).toEqual({ status: "ready" });
  });

  it("reports needs_login when the token has expired (401 from the real call)", async () => {
    const { io } = fakeRealMergeIo({
      code: 1,
      stdout: "",
      stderr: "API Error: 401 invalid bearer token"
    });

    const result = await probeProvider("anthropic", { io, cliPresent: async () => true });

    expect(result).toEqual({ status: "needs_login" });
  });

  it("reports needs_login when the CLI says authentication failed", async () => {
    const { io } = fakeRealMergeIo({
      code: 1,
      stdout: "",
      stderr: "failed to authenticate with Anthropic"
    });

    const result = await probeProvider("anthropic", { io, cliPresent: async () => true });

    expect(result).toEqual({ status: "needs_login" });
  });

  it("reports error, not needs_login, for an unrelated failure", async () => {
    const { io } = fakeRealMergeIo({ code: 1, stdout: "", stderr: "network timeout" });

    const result = await probeProvider("anthropic", { io, cliPresent: async () => true });

    expect(result).toEqual({ status: "error" });
  });

  it("caches a ready answer instead of calling claude again within the window", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    const first = await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-a" }
    });
    const second = await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-a" }
    });

    expect(calls).toHaveLength(1);
    expect(first).toEqual({ status: "ready" });
    expect(second).toEqual({ status: "ready" });
  });

  it("a new login token busts the cache instead of replaying the old answer", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-old" }
    });
    await probeProvider("anthropic", {
      io,
      cliPresent: async () => true,
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-new" }
    });

    expect(calls).toHaveLength(2);
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

describe("#2242: a refused sign-in outlives the provider's own readiness check", () => {
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  // Codex's readiness check only asks the local tool whether it is holding a credential file, so
  // it answers "logged in" straight after the vendor refused that very credential. The review
  // found exactly that: a refused model list correctly said Not logged in, and the readiness
  // check one line later said ready.
  it("codex asks for a login after the vendor refused the credential", async () => {
    const { io, calls } = fakeRealMergeIo({ code: 0, stdout: "Logged in using ChatGPT" });

    expect(await probeProvider("openai-compatible", { io, cliPresent: async () => true })).toEqual({
      status: "ready"
    });

    recordProviderLoginRejected("openai-compatible", {});

    expect(await probeProvider("openai-compatible", { io, cliPresent: async () => true })).toEqual({
      status: "needs_login"
    });
    // The local tool was not asked the second time; its answer could only have been the wrong one.
    expect(calls).toHaveLength(1);
  });

  it("google asks for a login after the vendor refused the credential", async () => {
    const { io } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
      status: "ready"
    });

    recordProviderLoginRejected("google", {});

    expect(await probeProvider("google", { io, cliPresent: async () => true })).toEqual({
      status: "needs_login"
    });
  });

  it("a fresh login that the provider accepts clears the refusal", async () => {
    const { io } = fakeRealMergeIo({ code: 0, stdout: "Logged in using ChatGPT" });

    recordProviderLoginRejected("openai-compatible", {});

    // Pressing Log in asks for a real check rather than an old saved answer.
    invalidateProviderProbeCache("openai-compatible", {});
    expect(
      await probeProvider("openai-compatible", {
        io,
        cliPresent: async () => true,
        forceFresh: true
      })
    ).toEqual({ status: "ready" });

    // And the refusal does not come back to haunt the next ordinary check.
    expect(await probeProvider("openai-compatible", { io, cliPresent: async () => true })).toEqual({
      status: "ready"
    });
  });

  it("a refusal with no credential named applies to whatever credential is checked next", async () => {
    // The chat stream never sees the token, so it names no credential when it reports a refusal.
    const { io } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    recordProviderLoginRejected("anthropic");

    expect(
      await probeProvider("anthropic", {
        io,
        cliPresent: async () => true,
        credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-anything" }
      })
    ).toEqual({ status: "needs_login" });
  });

  it("a readiness check that really succeeds clears the refusal", async () => {
    const { io } = fakeRealMergeIo({ code: 0, stdout: "OK\n" });

    recordProviderLoginRejected("anthropic");

    expect(
      await probeProvider("anthropic", {
        io,
        cliPresent: async () => true,
        credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-fresh" },
        forceFresh: true
      })
    ).toEqual({ status: "ready" });

    expect(
      await probeProvider("anthropic", {
        io,
        cliPresent: async () => true,
        credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "tok-fresh" }
      })
    ).toEqual({ status: "ready" });
  });
});
