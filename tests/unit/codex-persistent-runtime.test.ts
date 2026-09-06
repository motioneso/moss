/**
 * Unit tests for CodexPersistentRuntime (#1558, following #1557's ClaudePersistentRuntime tests).
 *
 * Codex has no process that stays open between turns, so every `submitTurn` spawns a fresh
 * process: the first spawn on a runtime instance runs `codex exec --json`, every later spawn
 * runs `codex exec resume --last --json` so Codex continues the same logical conversation.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexPersistentRuntime,
  CodexStreamDecoder,
  NEUTRAL_ADMISSION_FAILURE,
  NEUTRAL_CRASH_FAILURE,
  NEUTRAL_LAUNCH_FAILURE
} from "../../packages/chat/src/live/codex-persistent-runtime.js";
import type { RuntimeTurnEvent } from "../../packages/chat/src/live/provider-runtime.js";
import {
  clearProviderProbeCacheForTests,
  probeProvider
} from "../../packages/chat/src/live/provider-probe.js";
import type { EngineLaunchOpts } from "../../packages/chat/src/live/types.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal: string): boolean {
    this.signalCode = signal as NodeJS.Signals;
    setImmediate(() => {
      this.stdout.end();
      this.emit("exit", null, signal);
    });
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

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify(record)}\n`;
}

function emitReply(child: FakeChild, text: string): void {
  child.stdout.write(line({ type: "thread.started" }));
  child.stdout.write(line({ type: "turn.started" }));
  child.stdout.write(line({ type: "item.completed", item: { type: "agent_message", text } }));
  child.stdout.write(line({ type: "turn.completed" }));
  // Mirror a real `codex exec` process: it exits (closing stdout) once the turn is done.
  child.stdout.end();
}

async function collectUntilComplete(
  iterator: AsyncIterator<RuntimeTurnEvent>
): Promise<RuntimeTurnEvent[]> {
  const out: RuntimeTurnEvent[] = [];
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) return out;
    out.push(value);
    if (value.kind === "turn-complete" || value.kind === "turn-failed") return out;
  }
}

describe("CodexPersistentRuntime", () => {
  it("runs the first turn as `codex exec --json` and later turns as `codex exec resume --last --json`", async () => {
    const commands: string[] = [];
    const fakes: FakeChild[] = [];
    const spawnChild = vi.fn((command: string) => {
      commands.push(command);
      const fake = new FakeChild();
      fakes.push(fake);
      return asChild(fake);
    });
    const runtime = new CodexPersistentRuntime({ io, spawnChild });
    await runtime.launch(launchOpts());

    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();

    const firstTurn = collectUntilComplete(iterator);
    await runtime.submitTurn("turn-1", "hello");
    emitReply(fakes[0]!, "reply one");
    await firstTurn;

    const secondTurn = collectUntilComplete(iterator);
    await runtime.submitTurn("turn-2", "again");
    emitReply(fakes[1]!, "reply two");
    await secondTurn;

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("codex exec --json");
    expect(commands[0]).not.toContain("resume --last");
    expect(commands[1]).toContain("codex exec resume --last --json");

    const health = await runtime.health();
    expect(health.turnsCompleted).toBe(2);
  });

  it("surfaces an agent_message item as a reply record", async () => {
    const fake = new FakeChild();
    const runtime = new CodexPersistentRuntime({ io, spawnChild: () => asChild(fake) });
    await runtime.launch(launchOpts());

    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();
    const eventsPromise = collectUntilComplete(iterator);
    await runtime.submitTurn("turn-1", "hello");
    emitReply(fake, "the answer");
    const events = await eventsPromise;

    expect(events).toContainEqual({
      kind: "record",
      turnId: "turn-1",
      record: { kind: "reply", text: "the answer" }
    });
    expect(events.some((e) => e.kind === "turn-complete")).toBe(true);
  });

  it("is fail-closed on admission: a rejected readiness probe never spawns a process", async () => {
    const spawnChild = vi.fn(() => asChild(new FakeChild()));
    const runtime = new CodexPersistentRuntime({ io, spawnChild });

    await expect(
      runtime.launch(
        launchOpts({ mcpReadiness: async () => Promise.reject(new Error("not ready")) })
      )
    ).rejects.toThrow(NEUTRAL_ADMISSION_FAILURE);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("keeps neutral surfaces vendor-neutral", () => {
    for (const message of [
      NEUTRAL_ADMISSION_FAILURE,
      NEUTRAL_LAUNCH_FAILURE,
      NEUTRAL_CRASH_FAILURE
    ]) {
      expect(message.toLowerCase()).not.toContain("codex");
      expect(message.toLowerCase()).not.toContain("openai");
    }
  });

  it("recover() resubmits a crash before any tool ran, and refuses once a tool has run", async () => {
    const fakes: FakeChild[] = [];
    const spawnChild = vi.fn(() => {
      const fake = new FakeChild();
      fakes.push(fake);
      return asChild(fake);
    });
    const runtime = new CodexPersistentRuntime({ io, spawnChild });
    await runtime.launch(launchOpts());

    // Crash before any tool call: safe to resubmit.
    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();
    const firstAttempt = collectUntilComplete(iterator);
    await runtime.submitTurn("turn-1", "do something");
    fakes[0]!.stdout.end();
    await firstAttempt;

    const recovered = await runtime.recover("turn-1");
    expect(recovered).toEqual({ kind: "resubmitted" });
    expect(spawnChild).toHaveBeenCalledTimes(2);

    // The resubmitted attempt runs a tool, then crashes: no longer safe to resubmit.
    const secondAttempt = collectUntilComplete(iterator);
    fakes[1]!.stdout.write(line({ type: "thread.started" }));
    fakes[1]!.stdout.write(line({ type: "turn.started" }));
    fakes[1]!.stdout.write(
      line({ type: "item.completed", item: { type: "command_execution", command: "ls" } })
    );
    fakes[1]!.stdout.end();
    await secondAttempt;

    const notRecovered = await runtime.recover("turn-1");
    expect(notRecovered).toEqual({ kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE });
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it("health()/reap()/cancel() bookkeeping", async () => {
    const fake = new FakeChild();
    const runtime = new CodexPersistentRuntime({ io, spawnChild: () => asChild(fake) });
    await runtime.launch(launchOpts());

    let health = await runtime.health();
    expect(health.alive).toBe(false); // no process yet: nothing "alive" between turns

    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();
    const eventsPromise = collectUntilComplete(iterator);
    await runtime.submitTurn("turn-1", "hello");
    health = await runtime.health();
    expect(health.alive).toBe(true);

    const cancelOutcome = await runtime.cancel("turn-1");
    expect(cancelOutcome).toEqual({ approvalsResolved: 0 });
    await eventsPromise;

    await runtime.reap("idle-timeout");
    health = await runtime.health();
    expect(health.alive).toBe(false);
  });
});

describe("#2242: a codex chat message the provider refuses clears the saved sign-in answer", () => {
  afterEach(() => {
    clearProviderProbeCacheForTests();
  });

  // Round-3 review blocker 3: this provider announces a failed turn in its own frame, which the
  // reader ignored entirely - the turn died as a nameless end-of-process failure, the refusal was
  // thrown away, and the next readiness check said ready because the local tool was still holding
  // a sign-in file.
  const deps = {
    io: { run: async () => ({ code: 0, stdout: "Logged in using ChatGPT" }) },
    cliPresent: async () => true
  };

  async function drainFailedTurn(record: Record<string, unknown>): Promise<RuntimeTurnEvent[]> {
    const decoder = new CodexStreamDecoder({ killChild: () => {} });
    decoder.beginTurn("turn-1");
    decoder.write(`${JSON.stringify(record)}\n`);
    decoder.end();
    const events: RuntimeTurnEvent[] = [];
    for await (const event of decoder.events()) events.push(event);
    return events;
  }

  it("makes the next readiness check ask for a login, and keeps the provider's own words out", async () => {
    expect(await probeProvider("openai-compatible", deps)).toEqual({ status: "ready" });

    const events = await drainFailedTurn({
      type: "turn.failed",
      error: { message: "401 Unauthorized: invalid bearer token" }
    });

    expect(events).toHaveLength(1);
    const outcome = (events[0] as { outcome: { reason: string; loginRejected?: boolean } }).outcome;
    expect(outcome.loginRejected).toBe(true);
    expect(outcome.reason).toContain("Log in again");
    expect(outcome.reason).not.toContain("401");
    expect(outcome.reason).not.toContain("bearer");
    expect(await probeProvider("openai-compatible", deps)).toEqual({ status: "needs_login" });
  });

  it("leaves the saved answer alone when the failed turn was not about signing in", async () => {
    expect(await probeProvider("openai-compatible", deps)).toEqual({ status: "ready" });

    const events = await drainFailedTurn({
      type: "turn.failed",
      error: { message: "the assistant process ran out of memory" }
    });

    const outcome = (events[0] as { outcome: { reason: string; loginRejected?: boolean } }).outcome;
    expect(outcome.loginRejected).toBeUndefined();
    expect(outcome.reason).toContain("reported an error");
    expect(await probeProvider("openai-compatible", deps)).toEqual({ status: "ready" });
  });
});
