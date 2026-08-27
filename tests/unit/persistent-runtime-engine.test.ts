/**
 * Unit tests for ClaudePersistentRuntimeEngine (#1557 Phase 1, P1.6) — the CliChatEngine
 * adapter over ProviderChatRuntime. Exercises the push-to-poll bridge (readNew slicing a
 * buffer fed by streamEvents), the error-class mapping (pre-acceptance failure ⇒
 * CliChatUnavailableError; recover()'s neutral-failure ⇒ CliChatDeliveryUnknownError; a
 * "resubmitted" recovery is NOT surfaced as an error), and purgeTranscripts as a no-op.
 *
 * Uses a fake ProviderChatRuntime — no real child process, no real decoder — so this stays
 * a fast, deterministic test of the adapter's own logic in isolation.
 */
import { describe, expect, it } from "vitest";

import { ClaudePersistentRuntimeEngine } from "../../packages/chat/src/live/persistent-runtime-engine.js";
import {
  CliChatDeliveryUnknownError,
  CliChatUnavailableError
} from "../../packages/chat/src/live/errors.js";
import type {
  CancelOutcome,
  ProviderChatRuntime,
  ProviderRuntimeKind,
  ReapReason,
  RecoveryOutcome,
  RuntimeHealth,
  RuntimeTurnEvent
} from "../../packages/chat/src/live/provider-runtime.js";
import type { EngineLaunchOpts } from "../../packages/chat/src/live/types.js";

/** Minimal pushable async-iterable queue, standing in for the real bounded decoder's
 *  events() generator — supports waiting for events not yet pushed, and a clean close(). */
class FakeEventQueue implements AsyncIterable<RuntimeTurnEvent> {
  private readonly buffered: RuntimeTurnEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RuntimeTurnEvent>) => void> = [];
  private closed = false;

  push(event: RuntimeTurnEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.buffered.push(event);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeTurnEvent> {
    for (;;) {
      const next = this.buffered.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<RuntimeTurnEvent>>((resolve) =>
        this.waiters.push(resolve)
      );
      if (result.done) return;
      yield result.value;
    }
  }
}

class FakeRuntime implements ProviderChatRuntime {
  readonly kind: ProviderRuntimeKind = "persistent";
  readonly provider = "anthropic" as const;

  readonly queue = new FakeEventQueue();
  readonly submitCalls: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly reapCalls: ReapReason[] = [];
  readonly recoverCalls: string[] = [];
  launchCalls = 0;

  launchShouldThrow = false;
  submitShouldThrow = false;
  healthResult: RuntimeHealth = {
    alive: true,
    state: "idle",
    turnsCompleted: 0,
    lastResultAt: null
  };
  recoverImpl: (turnId: string) => Promise<RecoveryOutcome> = async () => ({
    kind: "resubmitted"
  });

  async launch(): Promise<void> {
    this.launchCalls += 1;
    if (this.launchShouldThrow) throw new Error("fake launch failure");
  }

  async submitTurn(turnId: string): Promise<void> {
    this.submitCalls.push(turnId);
    if (this.submitShouldThrow) throw new Error("fake submit failure");
  }

  streamEvents(): AsyncIterable<RuntimeTurnEvent> {
    return this.queue;
  }

  async cancel(turnId: string): Promise<CancelOutcome> {
    this.cancelCalls.push(turnId);
    return { approvalsResolved: 0 };
  }

  async health(): Promise<RuntimeHealth> {
    return this.healthResult;
  }

  async reap(reason: ReapReason): Promise<void> {
    this.reapCalls.push(reason);
  }

  async recover(turnId: string): Promise<RecoveryOutcome> {
    this.recoverCalls.push(turnId);
    return this.recoverImpl(turnId);
  }
}

function launchOpts(overrides: Partial<EngineLaunchOpts> = {}): EngineLaunchOpts {
  return {
    neutralDir: "/tmp/neutral",
    personaPath: "/tmp/neutral/persona.md",
    mcpToken: "jst_test",
    mcpServerUrl: "http://127.0.0.1:1/mcp",
    ...overrides
  };
}

function makeEngine(runtime: FakeRuntime): ClaudePersistentRuntimeEngine {
  return new ClaudePersistentRuntimeEngine(
    "session-1",
    { run: async () => ({ code: 0, stdout: "", stderr: "" }), writeFile: async () => undefined },
    { runtime }
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("ClaudePersistentRuntimeEngine", () => {
  it("drains streamEvents() records into readNew's buffer and reports turn completion", async () => {
    const runtime = new FakeRuntime();
    const engine = makeEngine(runtime);

    const launchResult = await engine.launch(launchOpts());
    expect(launchResult).toEqual({ offset: 0 });

    await engine.submit("hello");
    const turnId = runtime.submitCalls[0]!;
    runtime.queue.push({ kind: "record", turnId, record: { kind: "reply", text: "hi there" } });
    runtime.queue.push({ kind: "turn-complete", turnId });

    let result = await engine.readNew(0);
    // Poll: the pump drains streamEvents() asynchronously, so completion may lag this call.
    for (let i = 0; i < 200 && !result.complete; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      result = await engine.readNew(0);
    }

    expect(result.complete).toBe(true);
    expect(result.records).toEqual([{ kind: "reply", text: "hi there" }]);
  });

  it("maps a launch() rejection to CliChatUnavailableError", async () => {
    const runtime = new FakeRuntime();
    runtime.launchShouldThrow = true;
    const engine = makeEngine(runtime);

    await expect(engine.launch(launchOpts())).rejects.toBeInstanceOf(CliChatUnavailableError);
  });

  it("maps a submitTurn() rejection to CliChatUnavailableError", async () => {
    const runtime = new FakeRuntime();
    const engine = makeEngine(runtime);
    await engine.launch(launchOpts());
    runtime.submitShouldThrow = true;

    await expect(engine.submit("hello")).rejects.toBeInstanceOf(CliChatUnavailableError);
  });

  it("maps a neutral-failure recovery to CliChatDeliveryUnknownError on readNew, never resubmitting", async () => {
    const runtime = new FakeRuntime();
    runtime.recoverImpl = async () => ({
      kind: "neutral-failure",
      reason: "session died mid-turn"
    });
    const engine = makeEngine(runtime);

    await engine.launch(launchOpts());
    await engine.submit("hello");
    const turnId = runtime.submitCalls[0]!;
    runtime.queue.push({
      kind: "turn-failed",
      turnId,
      outcome: { kind: "neutral-failure", reason: "decoder-detected, ignored by adapter" }
    });

    await waitUntil(() => runtime.recoverCalls.length > 0);
    await expect(engine.readNew(0)).rejects.toThrow(CliChatDeliveryUnknownError);
    // Never resubmits on a neutral-failure outcome.
    expect(runtime.submitCalls).toEqual([turnId]);
  });

  it("transparently continues draining after a resubmitted recovery — no error surfaced", async () => {
    const runtime = new FakeRuntime();
    runtime.recoverImpl = async () => ({ kind: "resubmitted" });
    const engine = makeEngine(runtime);

    await engine.launch(launchOpts());
    await engine.submit("hello");
    const turnId = runtime.submitCalls[0]!;
    runtime.queue.push({
      kind: "turn-failed",
      turnId,
      outcome: { kind: "neutral-failure", reason: "ignored on resubmit path" }
    });
    await waitUntil(() => runtime.recoverCalls.length > 0);

    runtime.queue.push({
      kind: "record",
      turnId,
      record: { kind: "reply", text: "after recovery" }
    });
    runtime.queue.push({ kind: "turn-complete", turnId });

    let result = await engine.readNew(0);
    for (let i = 0; i < 50 && !result.complete; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      result = await engine.readNew(0);
    }

    expect(result.complete).toBe(true);
    expect(result.records).toEqual([{ kind: "reply", text: "after recovery" }]);
  });

  it("purgeTranscripts is a documented no-op (P1.0 --no-session-persistence posture)", async () => {
    const runtime = new FakeRuntime();
    const engine = makeEngine(runtime);
    await expect(engine.purgeTranscripts?.()).resolves.toBeUndefined();
  });

  it("isAlive delegates to runtime.health().alive", async () => {
    const runtime = new FakeRuntime();
    runtime.healthResult = { alive: false, state: "idle", turnsCompleted: 0, lastResultAt: null };
    const engine = makeEngine(runtime);
    expect(await engine.isAlive()).toBe(false);
  });

  it("kill() reaps with reason 'shutdown'", async () => {
    const runtime = new FakeRuntime();
    const engine = makeEngine(runtime);
    await engine.kill();
    expect(runtime.reapCalls).toEqual(["shutdown"]);
  });

  it("interrupt() cancels the current turn", async () => {
    const runtime = new FakeRuntime();
    const engine = makeEngine(runtime);
    await engine.launch(launchOpts());
    await engine.submit("hello");
    const turnId = runtime.submitCalls[0]!;

    await engine.interrupt();
    expect(runtime.cancelCalls).toEqual([turnId]);
  });

  // #1558 — the wrapper is provider-agnostic: an injected runtime works the same regardless of
  // which provider it belongs to, and `provider` defaults to "anthropic" for every call site
  // that predates this option.
  it("defaults provider to anthropic, and reports an injected provider's own value", () => {
    const defaultEngine = new ClaudePersistentRuntimeEngine(
      "session-1",
      { run: async () => ({ code: 0, stdout: "", stderr: "" }), writeFile: async () => undefined },
      { runtime: new FakeRuntime() }
    );
    expect(defaultEngine.provider).toBe("anthropic");

    const codexEngine = new ClaudePersistentRuntimeEngine(
      "session-1",
      { run: async () => ({ code: 0, stdout: "", stderr: "" }), writeFile: async () => undefined },
      { provider: "openai-compatible", runtime: new FakeRuntime() }
    );
    expect(codexEngine.provider).toBe("openai-compatible");
  });
});
