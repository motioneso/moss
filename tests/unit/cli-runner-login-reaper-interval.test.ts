/**
 * v0.1.3: the CliRunnerServer drives the max-age login reaper on a periodic interval while it
 * runs, and clears the timer on stop(). This is the disk-level BACKSTOP that releases the §L.6.1
 * single-active gate from a hung/abandoned login (the per-flow in-memory deadline alone can be
 * starved or stranded). Uses fake timers + a stub host so no real tmux/socket is needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliRunnerServer } from "../../packages/cli-runner/src/server.js";
import type { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";

// #1059 — CliRunnerServerDeps now requires terminalHost; this suite never touches the
// terminal RPC path, so one shared never-opened instance satisfies the type everywhere below.
const terminalHost = new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" });

let socketDir: string;

beforeEach(async () => {
  socketDir = await mkdtemp(path.join(tmpdir(), "jarv1s-reaper-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
});

function stubHost(reap: () => Promise<void>): CliChatEngineHost {
  return {
    startupSweep: async () => undefined,
    reapStaleLogins: reap,
    // #1554 task #5 — server.ts's start()/stop() now unconditionally call these two host
    // methods (mirroring the login reaper this suite exercises). No-op stubs: this suite is
    // about the login-reaper interval, not the idle-reap timer (see
    // cli-runner-server-idle-reap-wiring.test.ts for that).
    startIdleReapTimer: () => undefined,
    stopIdleReapTimer: () => undefined
  } as unknown as CliChatEngineHost;
}

describe("CliRunnerServer max-age login reaper interval (v0.1.3)", () => {
  it("drives host.reapStaleLogins on the configured interval, and stop() clears it", async () => {
    vi.useFakeTimers();
    const reap = vi.fn(async () => undefined);
    const server = new CliRunnerServer({
      host: stubHost(reap),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 50
    });

    await server.start();
    expect(reap).not.toHaveBeenCalled(); // nothing yet

    await vi.advanceTimersByTimeAsync(50);
    expect(reap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(reap).toHaveBeenCalledTimes(3);

    await server.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(reap).toHaveBeenCalledTimes(3); // no further ticks after stop
  });

  it("does not arm the reaper when the interval is 0 (off)", async () => {
    vi.useFakeTimers();
    const reap = vi.fn(async () => undefined);
    const server = new CliRunnerServer({
      host: stubHost(reap),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 0
    });
    await server.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reap).not.toHaveBeenCalled();
    await server.stop();
  });

  it("in-flight guard: a slow reap does NOT start a second concurrent reap (no stacking)", async () => {
    // The reap is held open (a wedged tmux command has no timeout), so several ticks fire while the
    // first reap is still in flight. The guard must skip those ticks — exactly ONE reap is running.
    vi.useFakeTimers();
    let release!: () => void;
    let active = 0;
    let maxConcurrent = 0;
    const reap = vi.fn(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise<void>((resolve) => {
        release = () => {
          active -= 1;
          resolve();
        };
      });
    });
    const server = new CliRunnerServer({
      host: stubHost(reap),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 50
    });

    await server.start();
    // First tick starts the (held) reap; the next ticks must be SKIPPED by the guard.
    await vi.advanceTimersByTimeAsync(50);
    expect(reap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200); // four more ticks elapse, all skipped
    expect(reap).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1); // never two reaps at once

    // Let the first reap settle; the NEXT tick may now start a fresh reap.
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(reap).toHaveBeenCalledTimes(2);

    release();
    await server.stop();
  });

  it("double-start guard: a second start() does not orphan the first reaper timer", async () => {
    vi.useFakeTimers();
    const reap = vi.fn(async () => undefined);
    const server = new CliRunnerServer({
      host: stubHost(reap),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 50
    });

    await server.start();
    await server.start(); // a second start must clear the first timer, not leak it

    await vi.advanceTimersByTimeAsync(50);
    // Exactly ONE tick fired (a single live timer), not two stacked timers.
    expect(reap).toHaveBeenCalledTimes(1);

    await server.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(reap).toHaveBeenCalledTimes(1); // stop() fully cleared it — no orphan keeps ticking
  });
});
