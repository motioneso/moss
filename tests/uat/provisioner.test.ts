import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// #1121 Task 4: pure arg-building coverage for buildSeedHookInput/composeSeedHook — no Docker.
// spawn is mocked so composeSeedHook's runCommand resolves immediately without touching a real
// process; only the args it was invoked with are asserted.
const mocks = vi.hoisted(() => ({
  spawn: vi.fn()
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: vi.fn() }));

const { buildSeedHookInput, composeSeedHook, writeUatEnvFile } = await import("./provisioner.js");

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
});

// #1121 regression: the seed hook's `docker -e` args above are seed-TIME only. The scripted
// provider (tests/uat/fixtures/scripted-provider/claude-main.ts) reads
// JARVIS_UAT_SEED_CHAT_SCRIPT from its own process env at app RUNTIME, inside the jarv1s
// container, whose only env conduit is docker-compose.prod.yml's `env_file:` — i.e. this file.
// Until this landed the var was set exclusively on the one-shot seed container, so the provider
// always read "", failed isUatChatScript, and exited at `missing-or-unknown-script-id` before
// writing any transcript record. The print engine spawns it detached with stdio:"ignore", so that
// exit was completely silent: every spec declaring uatLevel.chatScript timed out with an empty
// turn and never drove a real MCP tools/call.
describe("#1121: chatScript reaches the app container's env file", () => {
  const readEnvFile = (chatScript?: string) => {
    const file = writeUatEnvFile({ webPort: 18080, subnet: "10.254.0.0/24", chatScript });
    try {
      return readFileSync(file.path, "utf8").split("\n");
    } finally {
      file.cleanup();
    }
  };

  it("writes JARVIS_UAT_SEED_CHAT_SCRIPT when a chatScript is set", () => {
    expect(readEnvFile("1252-audit-truth")).toContain(
      "JARVIS_UAT_SEED_CHAT_SCRIPT=1252-audit-truth"
    );
  });

  it("omits the var entirely when no chatScript is set", () => {
    expect(readEnvFile().filter((line) => line.startsWith("JARVIS_UAT_SEED_CHAT_SCRIPT="))).toEqual(
      []
    );
  });
});
