/**
 * #1554 — `main.ts`'s `readConfig()` (the `MOSS_CHAT_PERSISTENT_*` bootstrap env vars)
 * and `createCliRunner()`'s persistent-pool composition (the forward-reference `hostRef` box
 * that resolves the pool ↔ host circular construction dependency, and the `persistentPool`/
 * `persistentRuntimePool`/`readIdleReapMinutes` deps it threads into `CliChatEngineHost`).
 *
 * `PersistentRuntimePool`/`ClaudePersistentRuntime` (`@moss/chat/live`) are mocked so this test
 * proves only the WIRING `createCliRunner` performs, not the pool's own admission/reap logic
 * (already covered by `packages/chat/src/live/persistent-runtime-pool.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MossChatLiveModule from "@moss/chat/live";

const { persistentRuntimePoolMock, claudePersistentRuntimeMock } = vi.hoisted(() => ({
  persistentRuntimePoolMock: vi.fn(),
  claudePersistentRuntimeMock: vi.fn()
}));

vi.mock("@moss/chat/live", async (importOriginal) => {
  const actual = await importOriginal<typeof MossChatLiveModule>();
  return {
    ...actual,
    PersistentRuntimePool: vi.fn().mockImplementation(function FakePersistentRuntimePool(
      this: unknown,
      opts: unknown
    ) {
      persistentRuntimePoolMock(opts);
      return { kind: "fake-pool", opts };
    }),
    ClaudePersistentRuntime: vi.fn().mockImplementation(function FakeClaudePersistentRuntime(
      this: unknown,
      opts: unknown
    ) {
      claudePersistentRuntimeMock(opts);
      return { kind: "fake-runtime" };
    })
  };
});

import { readConfig, createCliRunner } from "../../packages/cli-runner/src/main.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";

const BASE_ENV = {
  JARVIS_CLI_RUNNER_SOCKET: "/tmp/jarv1s-1554-task5/cli-runner.sock",
  JARVIS_CLI_HOME_BASE: "/tmp/jarv1s-1554-task5/home",
  JARVIS_CLI_NEUTRAL_BASE: "/tmp/jarv1s-1554-task5/neutral",
  JARVIS_CLI_TOOLS_PREFIX: "/tmp/jarv1s-1554-task5/tools"
};

describe("readConfig — persistent-pool boot-time env (#1554 task #5)", () => {
  it("defaults persistentRuntimeEnabled to false and cap/idle-reap to the registry defaults (4 / 30) when unset", () => {
    const config = readConfig({ ...BASE_ENV });
    expect(config.persistentRuntimeEnabled).toBe(false);
    expect(config.persistentPoolCap).toBe(4);
    expect(config.persistentIdleReapMinutes).toBe(30);
  });

  it("reads MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED/_POOL_CAP/_IDLE_REAP_MINUTES when set", () => {
    const config = readConfig({
      ...BASE_ENV,
      MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED: "1",
      MOSS_CHAT_PERSISTENT_POOL_CAP: "6",
      MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES: "15"
    });
    expect(config.persistentRuntimeEnabled).toBe(true);
    expect(config.persistentPoolCap).toBe(6);
    expect(config.persistentIdleReapMinutes).toBe(15);
  });

  it("falls back to the default (fail-closed, never 0) on a non-numeric or zero cap/idle-reap value", () => {
    const config = readConfig({
      ...BASE_ENV,
      MOSS_CHAT_PERSISTENT_POOL_CAP: "not-a-number",
      MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES: "0"
    });
    expect(config.persistentPoolCap).toBe(4);
    expect(config.persistentIdleReapMinutes).toBe(30);
  });
});

describe("createCliRunner — persistent-pool composition (#1554 task #5)", () => {
  afterEach(() => {
    persistentRuntimePoolMock.mockClear();
    claudePersistentRuntimeMock.mockClear();
    vi.restoreAllMocks();
  });

  it("constructs the pool even when the boot env flag is off — enable/disable is a live per-launch routing decision, not a boot-time existence one (#1554)", () => {
    const config = readConfig({ ...BASE_ENV });
    createCliRunner(config);
    expect(persistentRuntimePoolMock).toHaveBeenCalledTimes(1);
  });

  it("constructs the pool with the configured cap when persistentRuntimeEnabled is true, and the host's readIdleReapMinutes resolves to the configured value", async () => {
    const config = readConfig({
      ...BASE_ENV,
      MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED: "1",
      MOSS_CHAT_PERSISTENT_POOL_CAP: "6",
      MOSS_CHAT_PERSISTENT_IDLE_REAP_MINUTES: "15"
    });
    createCliRunner(config);

    expect(persistentRuntimePoolMock).toHaveBeenCalledTimes(1);
    const poolOpts = persistentRuntimePoolMock.mock.calls[0]![0] as {
      cap: () => number;
      createRuntime: () => unknown;
      onReap: (sessionKey: string, reason: string) => void;
    };
    // #1554: `cap` is a getter over the live-config holder, not a frozen number — boot env only
    // seeds it (see cli-runner-persistent-live-config.test.ts for the launch-param update path).
    expect(poolOpts.cap()).toBe(6);

    // createRuntime is the pool's factory for a fresh child — proves it delegates to the real
    // ClaudePersistentRuntime constructor rather than something ad hoc.
    poolOpts.createRuntime();
    expect(claudePersistentRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("wires the pool's onReap to the constructed host's notifySessionReaped (the hostRef forward-reference)", () => {
    const notifySpy = vi.spyOn(CliChatEngineHost.prototype, "notifySessionReaped");
    const config = readConfig({
      ...BASE_ENV,
      MOSS_CHAT_PERSISTENT_RUNTIME_ENABLED: "1"
    });
    createCliRunner(config);

    const poolOpts = persistentRuntimePoolMock.mock.calls[0]![0] as {
      onReap: (sessionKey: string, reason: string) => void;
    };
    poolOpts.onReap("session-9", "idle-timeout");

    expect(notifySpy).toHaveBeenCalledWith("session-9", "idle-timeout");
  });
});
