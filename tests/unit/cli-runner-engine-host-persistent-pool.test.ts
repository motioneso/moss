/**
 * #1554 task #5 — `CliChatEngineHost.launch` (`launchOnce`, `engine-host.ts`): lifting the
 * `persistentRuntimeEnabled: false` pin (Phase 1 pinned the RPC topology off, #1350
 * two-composition-roots guard). Pool presence (`EngineHostDeps.persistentRuntimePool`, wired at
 * `main.ts`'s composition root) now gates it: absent ⇒ unchanged pre-task-5 behavior (always
 * bounded/tmux, `createChatEngine` called with `persistentRuntimeEnabled: false`); present ⇒
 * `createChatEngine` is called with `persistentRuntimeEnabled: true` and the pool forwarded as
 * `persistentPool` (the admission seam `engine-selection.ts` consults — already covered end to
 * end by `packages/chat/src/live/engine-selection.test.ts`).
 *
 * `createChatEngine` itself is mocked here so this test proves ONLY the opts `launchOnce` passes
 * it, without needing to drive a real tmux/provider launch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { createChatEngineMock } = vi.hoisted(() => ({ createChatEngineMock: vi.fn() }));

vi.mock("@moss/chat/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@moss/chat/live")>();
  return { ...actual, createChatEngine: createChatEngineMock };
});

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import type { AdmitCapablePool } from "../../packages/chat/src/live/persistent-runtime-pool.js";

const NEUTRAL_BASE = "/tmp/jarvis-1554-task5-engine-host";

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

describe("CliChatEngineHost.launch — persistent-pool pin lift (#1554 task #5)", () => {
  afterEach(() => {
    createChatEngineMock.mockReset();
  });

  it("calls createChatEngine with persistentRuntimeEnabled:false and no pool when persistentRuntimePool is absent", async () => {
    createChatEngineMock.mockResolvedValue(fakeEngine());
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true
    });

    await host.launch("session-1", { provider: "anthropic", personaText: "" });

    expect(createChatEngineMock).toHaveBeenCalledTimes(1);
    const opts = createChatEngineMock.mock.calls[0]![3];
    expect(opts.persistentRuntimeEnabled).toBe(false);
    expect(opts.persistentPool).toBeUndefined();
  });

  it("calls createChatEngine with persistentRuntimeEnabled:true and the pool forwarded when persistentRuntimePool is present", async () => {
    createChatEngineMock.mockResolvedValue(fakeEngine());
    const pool: AdmitCapablePool = { admit: vi.fn(async () => ({ kind: "denied" as const })) };
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true,
      persistentRuntimePool: pool
    });

    await host.launch("session-2", { provider: "anthropic", personaText: "" });

    expect(createChatEngineMock).toHaveBeenCalledTimes(1);
    const opts = createChatEngineMock.mock.calls[0]![3];
    expect(opts.persistentRuntimeEnabled).toBe(true);
    expect(opts.persistentPool).toBe(pool);
  });
});

describe("CliChatEngineHost — onReap wiring seam (#1554 task #5)", () => {
  it("notifySessionReaped fans out to every registered reap listener with the exact (sessionKey, reason)", () => {
    const host = new CliChatEngineHost({
      io: fakeIo(),
      neutralBase: NEUTRAL_BASE,
      singleUser: false,
      cliPresent: async () => true
    });
    const listener = vi.fn();
    const unsubscribe = host.addSessionReapedListener(listener);

    // Mirrors what `main.ts`'s composition root does: a `PersistentRuntimePool`'s `onReap`
    // callback calls `host.notifySessionReaped(sessionKey, reason)` directly (see `main.ts`'s
    // `createCliRunner`'s `hostRef?.notifySessionReaped(...)` forward-reference wiring).
    host.notifySessionReaped("session-3", "idle-timeout");
    expect(listener).toHaveBeenCalledWith("session-3", "idle-timeout");

    unsubscribe();
    host.notifySessionReaped("session-3", "lru-evict");
    expect(listener).toHaveBeenCalledTimes(1); // not called again after unsubscribe
  });
});
