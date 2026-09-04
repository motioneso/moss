import { describe, expect, it, vi } from "vitest";
import type { TmuxIo } from "@moss/ai";
import { isBoundedFallbackEngine, createChatEngine } from "./engine-selection.js";
import { ClaudePrintChatEngine } from "./claude-print-chat-engine.js";
import { ClaudePersistentRuntimeEngine } from "./persistent-runtime-engine.js";
import type { AdmitCapablePool } from "./persistent-runtime-pool.js";
import type { ProviderChatRuntime } from "./provider-runtime.js";

function fakeIo(): TmuxIo {
  return {
    async run() {
      return { code: 0, stdout: "" };
    },
    async readFile() {
      throw new Error("not used");
    },
    async writeFile() {},
    async sleep() {}
  };
}

function fakeRuntime(): ProviderChatRuntime {
  return {
    kind: "persistent",
    provider: "anthropic",
    launch: vi.fn(async () => {}),
    submitTurn: vi.fn(async () => {}),
    streamEvents: async function* () {},
    cancel: vi.fn(async () => ({ approvalsResolved: 0 })),
    health: vi.fn(async () => ({
      alive: true,
      state: "idle" as const,
      turnsCompleted: 0,
      lastResultAt: 0
    })),
    reap: vi.fn(async () => {}),
    recover: vi.fn(async () => ({ kind: "neutral-failure" as const, reason: "n/a" }))
  };
}

describe("isBoundedFallbackEngine", () => {
  it("anthropic + non_interactive is bounded-fallback", () => {
    expect(isBoundedFallbackEngine("anthropic", "non_interactive")).toBe(true);
  });
});

describe("createChatEngine", () => {
  it("selects ClaudePrintChatEngine when persistentRuntimeEnabled is explicitly false", () => {
    const engine = createChatEngine("anthropic", "session-1", fakeIo(), {
      executionMode: "non_interactive",
      persistentRuntimeEnabled: false
    });
    expect(engine).toBeInstanceOf(ClaudePrintChatEngine);
  });

  // #1554 task #5 — the fork point's pool-consulting branch: a "denied" admission must fall all
  // the way back to the SAME bounded-fallback engine the flag-off path builds (ruling 5), not
  // throw or hang.
  it("falls back to the bounded engine when the pool denies admission", async () => {
    const pool: AdmitCapablePool = { admit: vi.fn(async () => ({ kind: "denied" as const })) };
    const engine = await createChatEngine("anthropic", "session-1", fakeIo(), {
      persistentRuntimeEnabled: true,
      persistentPool: pool
    });
    expect(pool.admit).toHaveBeenCalledTimes(1);
    expect(engine).not.toBeInstanceOf(ClaudePersistentRuntimeEngine);
  });

  // #1554 task #5 — an "admitted" result must hand the pool's already-constructed runtime to a
  // fresh `ClaudePersistentRuntimeEngine`, never construct a second, separate runtime.
  it("uses the admitted runtime when the pool admits", async () => {
    const runtime = fakeRuntime();
    const pool: AdmitCapablePool = {
      admit: vi.fn(async () => ({ kind: "admitted" as const, runtime }))
    };
    const engine = await createChatEngine("anthropic", "session-1", fakeIo(), {
      persistentRuntimeEnabled: true,
      persistentPool: pool
    });
    expect(pool.admit).toHaveBeenCalledTimes(1);
    expect(engine).toBeInstanceOf(ClaudePersistentRuntimeEngine);
  });

  it("stays synchronous (no pool supplied) so pre-task-5 call sites are unaffected", () => {
    const engine = createChatEngine("anthropic", "session-1", fakeIo(), {
      executionMode: "non_interactive",
      persistentRuntimeEnabled: false
    });
    expect(engine).not.toBeInstanceOf(Promise);
  });

  // Regression: email extraction (and every other scoped structured caller) always launches with
  // executionMode "non_interactive" and needs launchStructured/submitStructured/readStructured,
  // which only ClaudePrintChatEngine implements. Before this fix, an admitted pool won here even
  // for a non_interactive call, handing back a ClaudePersistentRuntimeEngine that has no
  // structured methods — every structured call then failed instantly with "structured-output".
  it("keeps the bounded print engine for a non_interactive call even when the pool admits", async () => {
    const runtime = fakeRuntime();
    const pool: AdmitCapablePool = {
      admit: vi.fn(async () => ({ kind: "admitted" as const, runtime }))
    };
    const engine = await createChatEngine("anthropic", "session-1", fakeIo(), {
      executionMode: "non_interactive",
      persistentRuntimeEnabled: true,
      persistentPool: pool
    });
    expect(pool.admit).not.toHaveBeenCalled();
    expect(engine).toBeInstanceOf(ClaudePrintChatEngine);
  });

  // #1558 — the Codex adapter takes the same unconditional-construct path as Claude when the
  // flag is on and no pool is supplied (the shared pool stays Claude-only).
  it("selects the persistent engine for openai-compatible when the flag is on", () => {
    const engine = createChatEngine("openai-compatible", "session-1", fakeIo(), {
      persistentRuntimeEnabled: true
    });
    expect(engine).not.toBeInstanceOf(Promise);
    expect(engine).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    expect((engine as ClaudePersistentRuntimeEngine).provider).toBe("openai-compatible");
  });
});
