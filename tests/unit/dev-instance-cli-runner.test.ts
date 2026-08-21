import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DevInstanceConfig } from "../../scripts/dev-instance/config.js";
import {
  RUN_DIR_REPAIR_COMMAND,
  ensureCliRunnerRunning,
  probeCliRunner
} from "../../scripts/dev-instance/cli-runner.js";

/** A connection that never completes its handshake — stands in for a dead/hung cli-runner. */
function hangingConnection() {
  let closed = false;
  return {
    handle: {
      ensureConnected: () => new Promise<void>(() => {}),
      close: () => {
        closed = true;
      }
    },
    wasClosed: () => closed
  };
}

describe("probeCliRunner (#1258 T15)", () => {
  let socketDir: string;

  beforeAll(async () => {
    socketDir = await mkdtemp(join(tmpdir(), "dev-instance-cli-runner-"));
  });

  afterAll(async () => {
    await rm(socketDir, { force: true, recursive: true });
  });

  it("reports not-reachable, naming the socket path, when the socket does not exist", async () => {
    const socketPath = join(socketDir, "cli-runner.sock");

    const status = await probeCliRunner(socketPath, "secret", { timeoutMs: 500 });

    expect(status.reachable).toBe(false);
    expect(status.socketPath).toBe(socketPath);
    expect(status.detail).toContain(socketPath);
  });

  it("names the missing run directory and the exact repair command when it does not exist", async () => {
    const socketPath = join(socketDir, "absent-dir", "cli-runner.sock");

    const status = await probeCliRunner(socketPath, "secret", { timeoutMs: 500 });

    expect(status.reachable).toBe(false);
    expect(status.detail).toContain(join(socketDir, "absent-dir"));
    expect(status.detail).toContain(RUN_DIR_REPAIR_COMMAND);
  });

  it("gives up at the deadline instead of waiting forever, and closes the connection", async () => {
    const connection = hangingConnection();
    const socketPath = join(socketDir, "cli-runner.sock");

    const started = Date.now();
    const status = await probeCliRunner(socketPath, "secret", {
      connect: () => connection.handle,
      timeoutMs: 150
    });

    expect(status.reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(connection.wasClosed()).toBe(true);
  });

  it("reports reachable when the connection completes", async () => {
    const socketPath = join(socketDir, "cli-runner.sock");

    const status = await probeCliRunner(socketPath, "secret", {
      connect: () => ({ close: () => {}, ensureConnected: () => Promise.resolve() }),
      timeoutMs: 500
    });

    expect(status.reachable).toBe(true);
    expect(status.detail).toContain(socketPath);
  });
});

describe("ensureCliRunnerRunning (#1258 T16)", () => {
  function config(socketPath: string): DevInstanceConfig {
    return {
      adminEmail: "owner@example.com",
      adminName: "Test Owner",
      adminPasswordFilePath: "/tmp/dev-instance-cli-runner-test-password",
      cliHomeBase: "/tmp/dev-instance-cli-runner-test-home",
      cliRunnerSocketPath: socketPath,
      credentialFilePath: "/tmp/dev-instance-cli-runner-test-credential.gpg",
      providerKind: "anthropic"
    };
  }

  const reachable = (socketPath: string) => ({
    detail: `cli-runner reachable at ${socketPath}`,
    reachable: true,
    socketPath
  });

  const unreachable = (socketPath: string) => ({
    detail: `cli-runner not reachable at ${socketPath}`,
    reachable: false,
    socketPath
  });

  it("does not spawn when the runner already answers", async () => {
    const socketPath = "/run/jarv1s/cli-runner.sock";
    let spawnCount = 0;

    const status = await ensureCliRunnerRunning(
      config(socketPath),
      {},
      {
        delay: () => Promise.resolve(),
        probe: () => Promise.resolve(reachable(socketPath)),
        spawnRunner: () => {
          spawnCount += 1;
        }
      }
    );

    expect(status.reachable).toBe(true);
    expect(spawnCount).toBe(0);
  });

  it("spawns once, then gives up after a bounded number of retries rather than waiting forever", async () => {
    const socketPath = "/run/jarv1s/cli-runner.sock";
    let spawnCount = 0;
    let probeCount = 0;

    const status = await ensureCliRunnerRunning(
      config(socketPath),
      {},
      {
        delay: () => Promise.resolve(),
        probe: () => {
          probeCount += 1;
          return Promise.resolve(unreachable(socketPath));
        },
        spawnRunner: () => {
          spawnCount += 1;
        }
      }
    );

    expect(status.reachable).toBe(false);
    expect(spawnCount).toBe(1);
    expect(probeCount).toBeGreaterThan(1);
    expect(probeCount).toBeLessThan(30);
    expect(status.detail).toContain("gave up");
  });

  it("reports reachable when the spawned runner comes up during the retry window", async () => {
    const socketPath = "/run/jarv1s/cli-runner.sock";
    let probeCount = 0;

    const status = await ensureCliRunnerRunning(
      config(socketPath),
      {},
      {
        delay: () => Promise.resolve(),
        probe: () => {
          probeCount += 1;
          return Promise.resolve(probeCount < 3 ? unreachable(socketPath) : reachable(socketPath));
        },
        spawnRunner: () => {}
      }
    );

    expect(status.reachable).toBe(true);
  });

  it("does not spawn, and names the repair, when the run directory is missing", async () => {
    const socketPath = join(tmpdir(), "dev-instance-absent-run-dir", "cli-runner.sock");
    let spawnCount = 0;

    const status = await ensureCliRunnerRunning(
      config(socketPath),
      {},
      {
        delay: () => Promise.resolve(),
        probe: () =>
          Promise.resolve({
            detail: `the directory ${join(tmpdir(), "dev-instance-absent-run-dir")} does not exist — ${RUN_DIR_REPAIR_COMMAND}`,
            reachable: false,
            socketPath
          }),
        spawnRunner: () => {
          spawnCount += 1;
        }
      }
    );

    expect(status.reachable).toBe(false);
    expect(spawnCount).toBe(0);
    expect(status.detail).toContain(RUN_DIR_REPAIR_COMMAND);
  });
});
