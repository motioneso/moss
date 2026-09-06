/**
 * AcpHost (#2369 slice 1): spawns the ACP adapter under the session identity and
 * pipes its stdio lines. Uses spawnChild injection so these tests are
 * pure/fast/deterministic — no real processes, no timers left dangling.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AcpHost } from "../../packages/cli-runner/src/acp-host.js";

class FakeChild extends EventEmitter {
  readonly written: string[] = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (line: string): void => {
      this.written.push(line);
    }
  };

  kill(): boolean {
    return true;
  }

  emitStdout(line: string): void {
    this.stdout.emit("data", Buffer.from(`${line}\n`));
  }

  exit(code: number): void {
    this.emit("exit", code);
  }
}

function makeHost(dir: string, child: FakeChild) {
  let lastSpawn: { cwd: string; env: NodeJS.ProcessEnv } | null = null;
  const host = new AcpHost({
    neutralBase: dir,
    resolveAdapterEntry: () => "/fake/adapter.js",
    spawnChild: (opts) => {
      lastSpawn = { cwd: opts.cwd, env: opts.env };
      return child as never;
    }
  });
  return { host, lastSpawn: () => lastSpawn };
}

describe("AcpHost", () => {
  it("spawns under a session folder and pipes lines with a cursor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host, lastSpawn } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj");
      expect(spawned.cwd).toBe(join(dir, "workshop:user:proj", "acp", "proj"));
      expect(lastSpawn()?.cwd).toBe(spawned.cwd);
      // The vendor login travels by environment, never the command line.
      expect(lastSpawn()?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

      host.send("workshop:user:proj", '{"jsonrpc":"2.0","id":1}');
      expect(child.written).toEqual(['{"jsonrpc":"2.0","id":1}\n']);

      child.emitStdout('{"jsonrpc":"2.0","id":1,"result":{}}');
      const first = host.read("workshop:user:proj", 0);
      expect(first.lines).toHaveLength(1);
      expect(first.nextSeq).toBe(1);
      const second = host.read("workshop:user:proj", first.nextSeq);
      expect(second.lines).toHaveLength(0);
      expect(second.exited).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a project id that could escape the session folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await expect(host.spawn("workshop:user:proj", "../evil")).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects multiline sends and reports exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await host.spawn("workshop:user:proj", "proj");
      expect(() => host.send("workshop:user:proj", "a\nb")).toThrow();
      child.exit(1);
      const result = host.read("workshop:user:proj", 0);
      expect(result.exited).toBe(true);
      expect(result.exitCode).toBe(1);
      host.kill("workshop:user:proj");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
