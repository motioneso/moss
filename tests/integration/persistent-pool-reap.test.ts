// tests/integration/persistent-pool-reap.test.ts
//
// #1554 Phase 2, task #7 (e2e-P2 "reap is real"), per
// docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md ~lines 345-377 (Fable-approved,
// authoritative — not re-litigated here). Decision 2's in-process tests (task #6) are the
// authoritative evidence for MCP token revocation on reap; this file deliberately does NOT assert
// revocation (Finding A) — it proves the one thing only observable from outside the process: real
// child-process lifetime and pool-slot reclamation, via `ps`, never logs.
//
// Real `PersistentRuntimePool` + real `ClaudePersistentRuntime` + real `createChatEngine`
// (engine-selection.ts) drive this test. The only substitution is `ClaudePersistentRuntime`'s
// `spawnChild` seam (explicitly "Injected for tests" per its own doc comment) pointed at
// tests/integration/fixtures/persistent-pool-fake-cli.mjs — a real, separately-spawned Node
// process standing in for the `claude` binary so no real CLI install or API credentials are
// needed, while still giving `ps` a genuine PID to observe and a genuine SIGTERM/SIGKILL to prove.
// The pool's idle-timeout math uses an injected `clock` (the pool's own designed test seam,
// `PersistentRuntimePoolDeps.clock`) so the real 1-minute-class threshold is proven without a real
// wall-clock wait.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { createRealTmuxIo } from "@moss/ai";

import { PersistentRuntimePool } from "../../packages/chat/src/live/persistent-runtime-pool.js";
import { ClaudePersistentRuntime } from "../../packages/chat/src/live/claude-persistent-runtime.js";
import { ClaudePersistentRuntimeEngine } from "../../packages/chat/src/live/persistent-runtime-engine.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";
import { createChatEngine, isBoundedFallbackEngine } from "../../packages/chat/src/live/engine-selection.js";
import type { ReapReason, RuntimeTurnEvent } from "../../packages/chat/src/live/provider-runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI_PATH = join(__dirname, "fixtures", "persistent-pool-fake-cli.mjs");

/** Real `ps -p <pid>`: true iff the OS still has a live process at that pid. Never a log read. */
function isProcessAlive(pid: number): boolean {
  try {
    execFileSync("ps", ["-p", String(pid)], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** Real `ps -p <pid> -o command=`: proves the live pid really is our fixture, not a coincidence. */
function processCommandLine(pid: number): string {
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
}

/** Poll a real condition without a fixed sleep — used only to await OS-level process exit after a
 *  kill signal has been sent (bounded by the pool's own 1s SIGTERM grace + SIGKILL). */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("persistent pool reap is real (#1554 e2e-P2)", () => {
  const neutralDirs: string[] = [];
  const pidsBySessionKey = new Map<string, number>();
  const tracked = new Map<string, ClaudePersistentRuntime>();
  const io = createRealTmuxIo();

  function makeNeutralDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "persistent-pool-reap-"));
    neutralDirs.push(dir);
    return dir;
  }

  function makeSpawnChild(sessionKey: string) {
    return (_command: string, cwd: string): ChildProcessWithoutNullStreams => {
      const child = spawn(process.execPath, [FAKE_CLI_PATH], {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      }) as ChildProcessWithoutNullStreams;
      if (child.pid) pidsBySessionKey.set(sessionKey, child.pid);
      return child;
    };
  }

  function launchOptsFor(sessionKey: string) {
    const neutralDir = makeNeutralDir();
    return {
      neutralDir,
      personaPath: join(neutralDir, "persona.md"),
      mcpToken: `test-token-${sessionKey}`,
      mcpServerUrl: "http://127.0.0.1:1/api/mcp",
      mcpReadiness: async () => undefined
    };
  }

  /** Drives one turn to completion on a real runtime so its health() reaches "idle" with a fresh
   *  lastResultAt — mirrors what ClaudePersistentRuntimeEngine's pump does in production, just
   *  scoped to exactly what this test needs (no MCP fetch involved). */
  async function completeOneTurn(runtime: ClaudePersistentRuntime, turnId: string): Promise<void> {
    const iterator = runtime.streamEvents()[Symbol.asyncIterator]();
    const drain = (async (): Promise<void> => {
      for (;;) {
        const { value, done } = (await iterator.next()) as { value: RuntimeTurnEvent; done: boolean };
        if (done) return;
        if (value.kind === "turn-complete") return;
      }
    })();
    await runtime.submitTurn(turnId, "hello");
    await drain;
  }

  let pool: PersistentRuntimePool;
  let fakeNow = Date.now();
  const reapEvents: { sessionKey: string; reason: ReapReason }[] = [];

  pool = new PersistentRuntimePool({
    cap: 2,
    createRuntime: (sessionKey) => {
      const runtime = new ClaudePersistentRuntime({ io, spawnChild: makeSpawnChild(sessionKey) });
      tracked.set(sessionKey, runtime);
      return runtime;
    },
    onReap: (sessionKey, reason) => reapEvents.push({ sessionKey, reason }),
    clock: { now: () => fakeNow }
  });

  afterAll(async () => {
    // Best-effort cleanup: reap anything still tracked so no fixture process outlives the suite.
    for (const [sessionKey] of tracked) {
      await pool.release(sessionKey, "shutdown");
    }
    for (const dir of neutralDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("step 1: cap=2 admits sessions 1-2 as real persistent processes, denies session 3 to the bounded fallback", async () => {
    const engine1 = await createChatEngine("anthropic", "session-1", io, {
      persistentRuntimeEnabled: true,
      executionMode: "non_interactive",
      persistentPool: pool
    });
    const engine2 = await createChatEngine("anthropic", "session-2", io, {
      persistentRuntimeEnabled: true,
      executionMode: "non_interactive",
      persistentPool: pool
    });
    const engine3 = await createChatEngine("anthropic", "session-3", io, {
      persistentRuntimeEnabled: true,
      executionMode: "non_interactive",
      persistentPool: pool
    });

    expect(engine1).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    expect(engine2).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    // Structural, not a log line: session 3 was denied admission (cap=2, no idle victim yet) and
    // engine-selection's own bounded-fallback rule independently agrees anthropic/non_interactive
    // is the bounded-fallback shape.
    expect(engine3).toBeInstanceOf(ClaudePrintChatEngine);
    expect(isBoundedFallbackEngine("anthropic", "non_interactive")).toBe(true);
    expect(pool.size()).toBe(2);

    const runtime1 = tracked.get("session-1")!;
    const runtime2 = tracked.get("session-2")!;
    await runtime1.launch(launchOptsFor("session-1"));
    await runtime2.launch(launchOptsFor("session-2"));

    const pid1 = pidsBySessionKey.get("session-1");
    const pid2 = pidsBySessionKey.get("session-2");
    expect(pid1).toBeTypeOf("number");
    expect(pid2).toBeTypeOf("number");

    // Real ps checks — exactly 2 persistent child processes exist, both genuinely our fixture.
    expect(isProcessAlive(pid1!)).toBe(true);
    expect(isProcessAlive(pid2!)).toBe(true);
    expect(processCommandLine(pid1!)).toContain("persistent-pool-fake-cli.mjs");
    expect(processCommandLine(pid2!)).toContain("persistent-pool-fake-cli.mjs");
  });

  it("step 2: idle-timeout reap kills session 1's real OS process via sweepIdle, leaves session 2 alone", async () => {
    const pid1 = pidsBySessionKey.get("session-1")!;
    const pid2 = pidsBySessionKey.get("session-2")!;
    const runtime1 = tracked.get("session-1")!;

    // Drive session 1 to a completed turn so health().state reaches "idle" with a real
    // lastResultAt (session 2 stays "ready" — never turned — so it is NOT reap-eligible and must
    // survive the sweep below).
    await completeOneTurn(runtime1, "turn-1");
    const health1 = await runtime1.health();
    expect(health1.state).toBe("idle");
    expect(health1.lastResultAt).not.toBeNull();

    // Advance the pool's injected clock past the idle threshold (mirrors
    // chat.persistent_idle_reap_minutes=1 from the plan) without a real wall-clock wait — the
    // clock is the pool's own designed test seam (PersistentRuntimePoolDeps.clock).
    const idleThresholdMs = 60_000;
    fakeNow = health1.lastResultAt! + idleThresholdMs + 5_000;

    await pool.sweepIdle(idleThresholdMs);

    expect(reapEvents).toContainEqual({ sessionKey: "session-1", reason: "idle-timeout" });
    expect(pool.size()).toBe(1);

    // Real ps check: session 1's process is genuinely gone (SIGTERM, or SIGKILL after the pool's
    // 1s grace) — not just absent from in-memory bookkeeping.
    await waitFor(() => !isProcessAlive(pid1), 5_000);
    expect(isProcessAlive(pid1)).toBe(false);

    // Session 2 was never idle — it must NOT have been touched by the sweep.
    expect(isProcessAlive(pid2)).toBe(true);
  });

  it("step 3: a 4th session reclaims the reaped slot and is admitted as persistent (real process again)", async () => {
    const engine4 = await createChatEngine("anthropic", "session-4", io, {
      persistentRuntimeEnabled: true,
      executionMode: "non_interactive",
      persistentPool: pool
    });

    expect(engine4).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    expect(pool.size()).toBe(2);

    const runtime4 = tracked.get("session-4")!;
    await runtime4.launch(launchOptsFor("session-4"));
    const pid4 = pidsBySessionKey.get("session-4");
    expect(pid4).toBeTypeOf("number");
    expect(isProcessAlive(pid4!)).toBe(true);
    expect(processCommandLine(pid4!)).toContain("persistent-pool-fake-cli.mjs");
  });
});
