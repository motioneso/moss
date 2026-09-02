import { beforeEach, describe, expect, it, vi } from "vitest";

// #1121 Task 4: pure arg-building coverage for buildSeedHookInput/composeSeedHook — no Docker.
// spawn is mocked so composeSeedHook's runCommand resolves immediately without touching a real
// process; only the args it was invoked with are asserted.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: vi.fn() }));

const { buildSeedHookInput, composeSeedHook, captureFailureEvidence } =
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
