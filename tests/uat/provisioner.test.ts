import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1121 Task 4: pure arg-building coverage for buildSeedHookInput/composeSeedHook — no Docker.
// spawn is mocked so composeSeedHook's runCommand resolves immediately without touching a real
// process; only the args it was invoked with are asserted.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: vi.fn() }));

const { buildSeedHookInput, composeSeedHook, captureFailureEvidence, cleanupUatAttempt } =
  await import("./provisioner.js");

describe("#1121 Task 4: chatScript arg-building", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stderr: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  it("buildSeedHookInput threads chatScript from UatProvisionOptions", () => {
    const withChatScript = buildSeedHookInput("proj", "solo-admin", { chatScript: "phase1-smoke" });
    expect(withChatScript.chatScript).toBe("phase1-smoke");

    const without = buildSeedHookInput("proj", "solo-admin", {});
    expect(without.chatScript).toBeUndefined();
  });

  it("composeSeedHook always passes JARVIS_UAT_SEED_CHAT_SCRIPT, empty when chatScript is absent", async () => {
    await composeSeedHook({ projectName: "proj", level: "solo-admin" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const index = args.indexOf("-e");
    const chatScriptArg = args.find((arg) => arg.startsWith("JARVIS_UAT_SEED_CHAT_SCRIPT="));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(chatScriptArg).toBe("JARVIS_UAT_SEED_CHAT_SCRIPT=");
  });

  it("composeSeedHook passes the chatScript id when set", async () => {
    await composeSeedHook({ projectName: "proj", level: "solo-admin", chatScript: "phase1-smoke" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const chatScriptArg = args.find((arg) => arg.startsWith("JARVIS_UAT_SEED_CHAT_SCRIPT="));
    expect(chatScriptArg).toBe("JARVIS_UAT_SEED_CHAT_SCRIPT=phase1-smoke");
  });

  it("threads the opt-in #1909 public-source fixture seed", async () => {
    const input = buildSeedHookInput("proj", "admin+data", {
      withSportsPublicSourceFixtures: true
    });
    expect(input.sportsPublicSourceFixtures).toBe(true);
    await composeSeedHook(input);

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("JARVIS_UAT_SPORTS_PUBLIC_SOURCE_FIXTURES=1");
  });

  it("starts ESPN-only provisioning without seeding a Job Search provider", async () => {
    const input = buildSeedHookInput(
      "proj",
      "admin+data",
      { withEspnFixture: true, chatScript: "phase1-smoke" },
      undefined
    );
    expect(input.jobSearchAiProviderBaseUrl).toBeUndefined();
    expect(input.chatScript).toBe("phase1-smoke");

    await composeSeedHook(input);

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("MOSS_UAT_JOB_SEARCH_AI_BASE_URL=");
    expect(args).toContain("JARVIS_UAT_SEED_CHAT_SCRIPT=phase1-smoke");
  });
});

describe("#2989: seed containers inherit only existing gate authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stderr: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["both markers", "1", "1", "1", "1"],
    ["legacy marker only", "1", undefined, "1", ""],
    ["Moss marker only", undefined, "1", "", "1"],
    ["legacy marker with an invalid Moss marker", "1", "0", "1", ""],
    ["Moss marker with an invalid legacy marker", "false", "1", "", "1"],
    ["missing markers", undefined, undefined, "", ""],
    ["empty markers", "", "", "", ""],
    ["false-like markers", "0", "false", "", ""],
    ["truthy but non-exact markers", "true", "yes", "", ""],
    ["whitespace around markers", " 1", "1 ", "", ""]
  ])(
    "propagates %s without inventing consent",
    async (_label, jarvis, moss, expectedJarvis, expectedMoss) => {
      vi.stubEnv("JARVIS_GATE_RUN", jarvis);
      vi.stubEnv("MOSS_GATE_RUN", moss);

      await composeSeedHook({ projectName: "uat-marker-test", level: "solo-admin" });

      const args = mocks.spawn.mock.calls[0]?.[1] as string[];
      const envArgs = args.flatMap((arg, index) => (arg === "-e" ? [args[index + 1]] : []));
      expect(envArgs).toContain(`JARVIS_GATE_RUN=${expectedJarvis}`);
      expect(envArgs).toContain(`MOSS_GATE_RUN=${expectedMoss}`);
      expect(envArgs.filter((arg) => /^(JARVIS|MOSS)_GATE_RUN=/.test(arg!))).toHaveLength(2);
      expect(envArgs).toContain("JARVIS_UAT_SEED_CONFIRM=1");
      expect(args.slice(0, 5)).toEqual([
        "compose",
        "-p",
        "uat-marker-test",
        "-f",
        "infra/docker-compose.prod.yml"
      ]);
      expect(args.at(-1)).toBe("seed");
    }
  );

  it("does not pass a direct-DB override, CI flag, or outer gate database target to seed", async () => {
    // Pure mocked-spawn coverage: these values never reach a Docker or database process.
    vi.stubEnv("JARVIS_GATE_RUN", undefined);
    vi.stubEnv("MOSS_GATE_RUN", undefined);
    vi.stubEnv("JARVIS_ALLOW_DIRECT_DB", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("JARVIS_PGHOST", "outer-gate.invalid");
    vi.stubEnv("MOSS_PGHOST", "outer-gate.invalid");
    vi.stubEnv("JARVIS_APP_DATABASE_URL", "postgres://outer-gate.invalid/outer-gate");
    vi.stubEnv("MOSS_APP_DATABASE_URL", "postgres://outer-gate.invalid/outer-gate");

    await composeSeedHook({ projectName: "uat-marker-test", level: "solo-admin" });

    const args = mocks.spawn.mock.calls[0]?.[1] as string[];
    const envArgs = args.flatMap((arg, index) => (arg === "-e" ? [args[index + 1]] : []));
    expect(envArgs).toContain("JARVIS_GATE_RUN=");
    expect(envArgs).toContain("MOSS_GATE_RUN=");
    expect(
      envArgs.some((arg) =>
        /^(?:(?:JARVIS|MOSS)_(?:ALLOW_DIRECT_DB|PGHOST|APP_DATABASE_URL)|CI)=/.test(arg!)
      )
    ).toBe(false);
    expect(args.some((arg) => arg.includes("outer-gate.invalid"))).toBe(false);
  });
});

describe("#2164 r19: captureFailureEvidence transcript capture is not tail-truncated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spawn.mockReturnValue({
      stdout: { on: vi.fn() },
      on: (event: string, listener: (code: number) => void) => {
        if (event === "exit") listener(0);
      }
    });
  });

  it("captures each transcript's full content instead of tailing it", async () => {
    await captureFailureEvidence("proj", "180s timeout");

    const execCall = mocks.spawn.mock.calls.find((call) => (call[1] as string[]).includes("exec"));
    const shellScript = (execCall?.[1] as string[]).at(-1) ?? "";
    expect(shellScript).toContain('cat "$f"');
    expect(shellScript).not.toContain("tail -c");
  });
});

describe("#2732 P1-1: cleanupUatAttempt still verifies the stack after a failed credential wipe", () => {
  it("still tears down and checks for leaks when the credential cleanup step throws", async () => {
    const teardownCompose = vi
      .fn()
      .mockRejectedValue(new Error("[uat real-chat] credential cleanup failed for proj"));
    const assertNoLeaks = vi.fn().mockResolvedValue(undefined);
    const cleanupEnvFile = vi.fn();

    await expect(
      cleanupUatAttempt({ teardownCompose, assertNoLeaks, cleanupEnvFile })
    ).rejects.toThrow(/credential cleanup failed/);

    // A failed credential wipe must not skip the stack-wide leak check or the env file cleanup —
    // both still ran even though teardownCompose rejected.
    expect(assertNoLeaks).toHaveBeenCalledTimes(1);
    expect(cleanupEnvFile).toHaveBeenCalledTimes(1);
  });

  it("surfaces both a failed credential wipe and a leaked volume together, with no credential content", async () => {
    const teardownCompose = vi
      .fn()
      .mockRejectedValue(new Error("[uat real-chat] credential cleanup failed for proj"));
    const assertNoLeaks = vi
      .fn()
      .mockRejectedValue(
        new Error('UAT teardown leaked resources for proj: volumes=["proj_jarv1s-cli-auth"]')
      );
    const cleanupEnvFile = vi.fn();

    await expect(
      cleanupUatAttempt({ teardownCompose, assertNoLeaks, cleanupEnvFile })
    ).rejects.toThrow(AggregateError);
    expect(cleanupEnvFile).toHaveBeenCalledTimes(1);
  });
});
