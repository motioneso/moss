/**
 * #1554 task #5 — `CliRunnerServer.start()`/`stop()` now call
 * `host.startIdleReapTimer()`/`host.stopIdleReapTimer()` (mirroring the existing login-reaper
 * wiring, `cli-runner-login-reaper-interval.test.ts`). The timer's OWN arm/no-op/double-start/
 * stop mechanics are already covered by `cli-runner-idle-reap-timer.test.ts` — this test only
 * proves `server.ts` actually calls those two host methods at the right points, using a stub
 * host so no real tmux/pool is needed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliRunnerServer } from "../../packages/cli-runner/src/server.js";
import type { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";

const terminalHost = new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" });

let socketDir: string;

beforeEach(async () => {
  socketDir = await mkdtemp(path.join(tmpdir(), "jarv1s-idle-reap-wiring-"));
});

afterEach(async () => {
  await rm(socketDir, { recursive: true, force: true }).catch(() => undefined);
});

function stubHost(startIdleReapTimer: () => void, stopIdleReapTimer: () => void): CliChatEngineHost {
  return {
    startupSweep: async () => undefined,
    startIdleReapTimer,
    stopIdleReapTimer
  } as unknown as CliChatEngineHost;
}

describe("CliRunnerServer idle-reap-timer wiring (#1554 task #5)", () => {
  it("calls host.startIdleReapTimer() during start() and host.stopIdleReapTimer() during stop()", async () => {
    const startIdleReapTimer = vi.fn();
    const stopIdleReapTimer = vi.fn();
    const server = new CliRunnerServer({
      host: stubHost(startIdleReapTimer, stopIdleReapTimer),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 0
    });

    await server.start();
    expect(startIdleReapTimer).toHaveBeenCalledTimes(1);
    expect(stopIdleReapTimer).not.toHaveBeenCalled();

    await server.stop();
    expect(stopIdleReapTimer).toHaveBeenCalledTimes(1);
  });

  it("calls host.startIdleReapTimer() unconditionally even with no pool wired (the method itself is the no-op, not this call site)", async () => {
    // Simulates the persistentRuntimeEnabled:false composition path (`main.ts`): the deps still
    // supply the two methods (real CliChatEngineHost always has them; only the pool dep is
    // absent) and `server.ts` must call them regardless — `host.startIdleReapTimer()`'s own
    // no-op-when-no-pool behavior is what makes this harmless (covered separately).
    const startIdleReapTimer = vi.fn();
    const stopIdleReapTimer = vi.fn();
    const server = new CliRunnerServer({
      host: stubHost(startIdleReapTimer, stopIdleReapTimer),
      socketPath: path.join(socketDir, "cli-runner.sock"),
      socketDir,
      secret: "s",
      terminalHost,
      loginReaperIntervalMs: 0
    });

    await server.start();
    expect(startIdleReapTimer).toHaveBeenCalledTimes(1);
    await server.stop();
  });
});
