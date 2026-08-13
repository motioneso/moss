/**
 * #1554 — the persistent-runtime settings (`chat.persistent_runtime.enabled`,
 * `chat.persistent_pool_cap`, `chat.persistent_idle_reap_minutes`) must reach the cli-runner root
 * inside RPC LAUNCH PARAMS and take effect WITHOUT a process restart (plan "Settings & flags":
 * "Values reach the cli-runner root inside RPC launch params"; spec AC5 / the rollout's
 * "flip the flag, no deploy" guarantee).
 *
 * Boot-time env (`MOSS_CHAT_PERSISTENT_*`) is only the bootstrap default for the first launch
 * before any RPC params arrive — it must never pin the values for the life of the process. These
 * tests drive TWO launches through ONE `CliChatEngineHost` instance with different params and
 * assert the routing/admission behaviour changes across them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MossChatLiveModule from "@moss/chat/live";

const { createChatEngineMock, persistentRuntimePoolMock } = vi.hoisted(() => ({
  createChatEngineMock: vi.fn(),
  persistentRuntimePoolMock: vi.fn()
}));

vi.mock("@moss/chat/live", async (importOriginal) => {
  const actual = await importOriginal<typeof MossChatLiveModule>();
  return {
    ...actual,
    createChatEngine: createChatEngineMock,
    PersistentRuntimePool: vi.fn().mockImplementation(function FakePersistentRuntimePool(
      this: unknown,
      opts: unknown
    ) {
      persistentRuntimePoolMock(opts);
      return { kind: "fake-pool", admit: vi.fn(async () => ({ kind: "denied" as const })) };
    }),
    ClaudePersistentRuntime: vi.fn().mockImplementation(function FakeClaudePersistentRuntime() {
      return { kind: "fake-runtime" };
    })
  };
});

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import {
  CliChatEngineHost,
  type PersistentRuntimeLiveConfig
} from "../../packages/cli-runner/src/engine-host.js";
import { createCliRunner, readConfig } from "../../packages/cli-runner/src/main.js";
import type { AdmitCapablePool } from "../../packages/chat/src/live/persistent-runtime-pool.js";

const NEUTRAL_BASE = "/tmp/jarvis-1554-live-config";

function fakeIo(): TmuxIo {
  return {
    run: vi.fn(async () => ({ code: 0, stdout: "" })),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    sleep: vi.fn(async () => {})
  };
}

function fakeEngine() {
  return {
    provider: "anthropic",
    launch: vi.fn(async () => ({ offset: 0 })),
    submit: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    readNew: vi.fn(async () => ({ records: [], offset: 0, complete: true })),
    kill: vi.fn(async () => {})
  };
}

function bootConfig(): PersistentRuntimeLiveConfig {
  return { enabled: false, poolCap: 4, idleReapMinutes: 30 };
}

describe("CliChatEngineHost — persistent config live-reloads from RPC launch params (#1554)", () => {
  afterEach(() => {
    createChatEngineMock.mockReset();
    persistentRuntimePoolMock.mockClear();
  });

  it("flips persistent routing on and back off across two launches on the SAME host (no restart)", async () => {
    createChatEngineMock.mockResolvedValue(fakeEngine());
    const pool: AdmitCapablePool = { admit: vi.fn(async () => ({ kind: "denied" as const })) };
    const liveConfig = bootConfig();
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true,
      persistentRuntimePool: pool,
      persistentLiveConfig: liveConfig
    });

    // Launch 1: the flag arrives ON in the launch params even though boot env had it OFF.
    await host.launch("session-a", {
      provider: "anthropic",
      personaText: "",
      persistentRuntimeEnabled: true
    });
    expect(createChatEngineMock.mock.calls[0]![3].persistentRuntimeEnabled).toBe(true);
    expect(createChatEngineMock.mock.calls[0]![3].persistentPool).toBe(pool);

    // Launch 2: the operator flipped the setting OFF — same process, same host instance.
    await host.launch("session-b", {
      provider: "anthropic",
      personaText: "",
      persistentRuntimeEnabled: false
    });
    expect(createChatEngineMock.mock.calls[1]![3].persistentRuntimeEnabled).toBe(false);
  });

  it("updates the shared cap / idle-reap holder from each launch's params", async () => {
    createChatEngineMock.mockResolvedValue(fakeEngine());
    const liveConfig = bootConfig();
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true,
      persistentRuntimePool: { admit: vi.fn(async () => ({ kind: "denied" as const })) },
      persistentLiveConfig: liveConfig
    });

    await host.launch("session-c", {
      provider: "anthropic",
      personaText: "",
      persistentRuntimeEnabled: true,
      persistentPoolCap: 6,
      persistentIdleReapMinutes: 15
    });
    expect(liveConfig).toEqual({ enabled: true, poolCap: 6, idleReapMinutes: 15 });

    await host.launch("session-d", {
      provider: "anthropic",
      personaText: "",
      persistentPoolCap: 2,
      persistentIdleReapMinutes: 5
    });
    // enabled is sticky (absent field ⇒ last known value); cap/idle-reap moved.
    expect(liveConfig).toEqual({ enabled: true, poolCap: 2, idleReapMinutes: 5 });
  });

  it("ignores non-positive / non-numeric cap and idle-reap values (fail-closed, never 0)", async () => {
    createChatEngineMock.mockResolvedValue(fakeEngine());
    const liveConfig = bootConfig();
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true,
      persistentLiveConfig: liveConfig
    });

    await host.launch("session-e", {
      provider: "anthropic",
      personaText: "",
      persistentPoolCap: 0,
      persistentIdleReapMinutes: Number.NaN
    });
    expect(liveConfig.poolCap).toBe(4);
    expect(liveConfig.idleReapMinutes).toBe(30);
  });
});

describe("createCliRunner — pool is unconditional and reads the live holder (#1554)", () => {
  afterEach(() => {
    createChatEngineMock.mockReset();
    persistentRuntimePoolMock.mockClear();
  });

  const BASE_ENV = {
    JARVIS_CLI_RUNNER_SOCKET: "/tmp/jarv1s-1554-live/cli-runner.sock",
    JARVIS_CLI_HOME_BASE: "/tmp/jarv1s-1554-live/home",
    JARVIS_CLI_NEUTRAL_BASE: "/tmp/jarv1s-1554-live/neutral",
    JARVIS_CLI_TOOLS_PREFIX: "/tmp/jarv1s-1554-live/tools"
  };

  it("constructs the pool even when the boot env flag is off, with a cap that tracks later launch params", () => {
    const server = createCliRunner(readConfig({ ...BASE_ENV }));

    expect(persistentRuntimePoolMock).toHaveBeenCalledTimes(1);
    const poolOpts = persistentRuntimePoolMock.mock.calls[0]![0] as { cap: () => number };
    expect(poolOpts.cap()).toBe(4); // boot bootstrap default

    // Reach the composed host to prove the SAME holder backs the pool's cap getter — an operator
    // raising `chat.persistent_pool_cap` must widen admission without restarting the runner.
    const host = (server as unknown as { deps: { host: CliChatEngineHost } }).deps.host;
    host.applyPersistentRuntimeParams({
      provider: "anthropic",
      personaText: "",
      persistentPoolCap: 9
    });
    expect(poolOpts.cap()).toBe(9);
  });
});
