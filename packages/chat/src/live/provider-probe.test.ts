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
