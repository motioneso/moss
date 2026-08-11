/**
 * Unit tests for ClaudePersistentRuntime and createMcpReadinessProbe (#1557 Phase 1, P1.3/P1.4).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  ClaudePersistentRuntime,
  NEUTRAL_ADMISSION_FAILURE,
  NEUTRAL_CRASH_FAILURE,
  NEUTRAL_LAUNCH_FAILURE,
  createMcpReadinessProbe
} from "../../packages/chat/src/live/claude-persistent-runtime.js";
import type { RuntimeTurnEvent } from "../../packages/chat/src/live/provider-runtime.js";
import type { EngineLaunchOpts } from "../../packages/chat/src/live/types.js";

interface StdinWrite {
  readonly chunk: string;
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: { readonly writes: StdinWrite[]; write: (...args: unknown[]) => boolean };
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: string[] = [];

  constructor() {
    super();
    const writes: StdinWrite[] = [];
    this.stdin = {
      writes,
      write: (...args: unknown[]) => {
        const chunk = args[0] as string;
        const cb = args.find((a) => typeof a === "function") as
          | ((error?: Error) => void)
          | undefined;
        writes.push({ chunk });
        cb?.();
        return true;
      }
    };
  }

  kill(signal: string): boolean {
    this.kills.push(signal);
    this.signalCode = signal as NodeJS.Signals;
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

function asChild(fake: FakeChild): ChildProcessWithoutNullStreams {
  return fake as unknown as ChildProcessWithoutNullStreams;
}

const io = {
  run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
  writeFile: vi.fn(async () => undefined)
};

type LaunchOptsWithReadiness = EngineLaunchOpts & { readonly mcpReadiness: () => Promise<void> };

function launchOpts(overrides: Partial<LaunchOptsWithReadiness> = {}): LaunchOptsWithReadiness {
  return {
    neutralDir: "/tmp/neutral",
    personaPath: "/tmp/neutral/persona.md",
    mcpToken: "tok-123",
    mcpServerUrl: "http://localhost:4000/api/mcp",
    mcpReadiness: async () => undefined,
    ...overrides
  };
}

function emitAssistantReply(child: FakeChild, text: string): void {
  child.stdout.write(
    `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] }
    })}\n`
  );
  child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
}

describe("ClaudePersistentRuntime", () => {
  it("serves three turns on one spawned process", async () => {
    const fake = new FakeChild();
    const spawnChild = vi.fn(() => asChild(fake));
    const runtime = new ClaudePersistentRuntime({ io, spawnChild });

    await runtime.launch(launchOpts());
    expect(spawnChild).toHaveBeenCalledTimes(1);

    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();
    const collectUntilComplete = async (): Promise<RuntimeTurnEvent[]> => {
      const out: RuntimeTurnEvent[] = [];
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return out;
        out.push(value);
        if (value.kind === "turn-complete") return out;
      }
    };

    for (let i = 1; i <= 3; i++) {
      const turnId = `turn-${i}`;
      const eventsPromise = collectUntilComplete();
      await runtime.submitTurn(turnId, `hello ${i}`);
      emitAssistantReply(fake, `reply ${i}`);
      const events = await eventsPromise;
      expect(events.some((e) => e.kind === "turn-complete")).toBe(true);
    }

    expect(spawnChild).toHaveBeenCalledTimes(1);
    const health = await runtime.health();
    expect(health.turnsCompleted).toBe(3);
    expect(health.alive).toBe(true);
  });

  it("is fail-closed on admission: rejected readiness kills the child before any frame is sent", async () => {
    const fake = new FakeChild();
    const spawnChild = vi.fn(() => asChild(fake));
    const runtime = new ClaudePersistentRuntime({ io, spawnChild });

    await expect(
      runtime.launch(launchOpts({ mcpReadiness: async () => Promise.reject(new Error("not ready")) }))
    ).rejects.toThrow(NEUTRAL_ADMISSION_FAILURE);

    expect(fake.kills).toContain("SIGTERM");
    expect(fake.stdin.writes).toEqual([]);
  });

  it("keeps neutral surfaces vendor-neutral", () => {
    for (const message of [NEUTRAL_ADMISSION_FAILURE, NEUTRAL_LAUNCH_FAILURE, NEUTRAL_CRASH_FAILURE]) {
      expect(message.toLowerCase()).not.toContain("claude");
      expect(message.toLowerCase()).not.toContain("anthropic");
    }
  });

  it("health()/reap()/cancel() bookkeeping", async () => {
    const fake = new FakeChild();
    const runtime = new ClaudePersistentRuntime({ io, spawnChild: () => asChild(fake) });
    await runtime.launch(launchOpts());

    const cancelOutcome = await runtime.cancel("turn-1");
    expect(cancelOutcome).toEqual({ approvalsResolved: 0 });
    expect(fake.kills).toContain("SIGINT");

    await runtime.reap("idle-timeout");
    const health = await runtime.health();
    expect(health.alive).toBe(false);
  });

  it("recover() resubmits only when the frame was never accepted, and refuses a second attempt", async () => {
    const fakes: FakeChild[] = [];
    const spawnChild = vi.fn(() => {
      const fake = new FakeChild();
      fakes.push(fake);
      return asChild(fake);
    });
    const runtime = new ClaudePersistentRuntime({ io, spawnChild });
    await runtime.launch(launchOpts());

    // No matching in-flight turn at all — not provably-pre-acceptance-safe.
    const outcomeNoMatch = await runtime.recover("never-submitted-turn");
    expect(outcomeNoMatch).toEqual({ kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE });

    // Simulate a submit whose write callback never resolves (the process died mid-write): the
    // frame is never marked accepted, so recover() must still be able to resubmit it.
    const hungChild = fakes[0]!;
    hungChild.stdin.write = (...args: unknown[]) => {
      hungChild.stdin.writes.push({ chunk: args[0] as string });
      return true; // deliberately never invoke the write callback
    };
    void runtime.submitTurn("turn-x", "do something");
    await Promise.resolve();

    const outcome = await runtime.recover("turn-x");
    expect(outcome).toEqual({ kind: "resubmitted" });
    expect(spawnChild).toHaveBeenCalledTimes(2);

    const secondAttempt = await runtime.recover("turn-x");
    expect(secondAttempt).toEqual({ kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE });
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });
});

describe("createMcpReadinessProbe", () => {
  it("resolves when initialize and tools/list both return 200 with no error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 })
    );
    const probe = createMcpReadinessProbe("http://localhost/api/mcp", "tok", fetchImpl as unknown as typeof fetch);
    await expect(probe()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));
    const probe = createMcpReadinessProbe("http://localhost/api/mcp", "tok", fetchImpl as unknown as typeof fetch);
    await expect(probe()).rejects.toThrow(NEUTRAL_ADMISSION_FAILURE);
  });

  it("rejects when the body carries a JSON-RPC error even at HTTP 200", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no session" } }),
        { status: 200 }
      )
    );
    const probe = createMcpReadinessProbe("http://localhost/api/mcp", "tok", fetchImpl as unknown as typeof fetch);
    await expect(probe()).rejects.toThrow(NEUTRAL_ADMISSION_FAILURE);
  });
});
