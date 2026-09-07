/**
 * AcpHost builds (#2369 slice 1 phase 3): one shell command runs in the
 * session project folder, output is capped at 256 KiB, and the deadline kills
 * the command while keeping whatever ran so far. Real processes throughout —
 * these prove the runner path, not a stub of it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACP_EXEC_DEFAULT_TIMEOUT_MS,
  ACP_EXEC_OUTPUT_CAP_BYTES,
  AcpHost
} from "../../packages/cli-runner/src/acp-host.js";

const KEY = "workshop:user:proj";
const PROJECT = "proj";

function makeHost(dir: string) {
  return new AcpHost({ neutralBase: dir });
}

async function pollUntil(
  poll: () => { done: boolean },
  timeoutMs = 10_000
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (poll().done) return;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the build");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("AcpHost builds", () => {
  it("runs the command in the session project folder and returns its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "pwd; echo hello-build");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.exitCode).toBe(0);
      expect(final.timedOut).toBe(false);
      expect(final.truncated).toBe(false);
      expect(final.output).toContain("hello-build");
      // The working directory is the session project folder, not chosen by the caller.
      expect(final.output).toContain(join(dir, KEY, "acp", PROJECT));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the same folder an adapter spawn for that session uses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const { EventEmitter } = await import("node:events");
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: () => undefined },
        kill: () => true
      }) as never;
      const host = new AcpHost({
        neutralBase: dir,
        resolveAdapterEntry: () => "/fake/adapter.js",
        spawnChild: () => child
      });
      const spawned = await host.spawn(KEY, PROJECT);
      const { execId } = await host.execStart(KEY, PROJECT, "pwd");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.output.trim()).toBe(spawned.cwd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges stderr into the output so failing builds keep their error text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "echo out; echo err >&2; exit 3");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.exitCode).toBe(3);
      expect(final.output).toContain("out");
      expect(final.output).toContain("err");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills past the deadline and keeps whatever ran so far", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "echo started; sleep 30", 300);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.timedOut).toBe(true);
      expect(final.output).toContain("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a running build on kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30");
      host.execKill(KEY, execId);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.timedOut).toBe(false);
      // Killing an unknown build is a no-op, never an error.
      expect(() => host.execKill(KEY, 999_999)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps output at 256 KiB and says it was cut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(
        KEY,
        PROJECT,
        "node -e \"process.stdout.write('x'.repeat(300 * 1024))\""
      );
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.truncated).toBe(true);
      expect(Buffer.byteLength(final.output, "utf8")).toBeLessThanOrEqual(
        ACP_EXEC_OUTPUT_CAP_BYTES
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bad project, an empty command, and a bad deadline before spawning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      let spawned = 0;
      const host = new AcpHost({
        neutralBase: dir,
        spawnExec: () => {
          spawned += 1;
          throw new Error("must not spawn");
        }
      });
      await expect(host.execStart(KEY, "../escape", "echo hi")).rejects.toThrow(/projectId/);
      await expect(host.execStart(KEY, PROJECT, "")).rejects.toThrow(/command/);
      await expect(host.execStart(KEY, PROJECT, "echo hi", 0)).rejects.toThrow(/timeoutMs/);
      await expect(host.execStart(KEY, PROJECT, "echo hi", 11 * 60 * 1000)).rejects.toThrow(
        /timeoutMs/
      );
      expect(() => host.execPoll(KEY, -1)).toThrow();
      expect(() => host.execPoll(KEY, 999_999)).toThrow(/not running/);
      expect(spawned).toBe(0);
      expect(ACP_EXEC_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
