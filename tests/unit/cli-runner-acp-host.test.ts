/**
 * AcpHost (#2369 slice 1): spawns the ACP adapter under the session identity and
 * pipes its stdio lines. Uses spawnChild injection so these tests are
 * pure/fast/deterministic — no real processes, no timers left dangling.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
      // A second project lands in its own sibling folder, never inside the first.
      const other = await host.spawn("workshop:user:proj", "other");
      expect(other.cwd).not.toBe(spawned.cwd);
      expect(spawned.cwd.startsWith(other.cwd)).toBe(false);
      expect(other.cwd.startsWith(spawned.cwd)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes narrowing project settings at the path the adapter reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj");
      const settingsPath = join(spawned.cwd, ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        permissions?: { deny?: string[] };
      };
      // Shell and writes are denied outright; a bare tool name matches every use.
      expect(settings.permissions?.deny).toEqual(expect.arrayContaining(["Bash", "Write", "Edit"]));
      // The deny list matches the tool table's shell and write rows exactly
      // (bare names only), so launch and policy cannot drift apart.
      const { acpToolNamesIn } = await import("../../packages/acp/src/tool-table.js");
      const tableRows = [...acpToolNamesIn("shell", "write")].filter(
        (name) => !name.startsWith("mcp__acp__")
      );
      expect(new Set(settings.permissions?.deny)).toEqual(new Set(tableRows));
      // The old dead path is gone: nothing writes outside the adapter's layout.
      expect(existsSync(join(spawned.cwd, ".Muse"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("locks session folders owner-only and says so when it cannot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj");
      const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
      expect(mode(spawned.cwd)).toBe("700");
      expect(mode(join(spawned.cwd, ".claude"))).toBe("700");

      // With per-user identity on but no root, the handover fails — and the
      // failure is said out loud instead of silently skipping isolation.
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message));
      };
      try {
        mkdirSync(join(dir, "homes"), { recursive: true });
        const loud = new AcpHost({
          neutralBase: dir,
          homeBase: join(dir, "homes"),
          perUserUid: true,
          resolveAdapterEntry: () => "/fake/adapter.js",
          spawnChild: () => child as never
        });
        await loud.spawn("workshop:user:proj2", "proj");
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.some((w) => w.includes("could not hand"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps one reply and says plainly when it cut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await host.spawn("workshop:user:proj", "proj");
      // Five 300 KiB lines: over the 1 MiB reply cap.
      for (let i = 0; i < 5; i++) child.emitStdout(`x${i}${"y".repeat(300 * 1024)}`);
      const result = host.read("workshop:user:proj", 0);
      const bytes = result.lines.reduce((n, line) => n + Buffer.byteLength(line), 0);
      expect(bytes).toBeLessThanOrEqual(1024 * 1024);
      expect(result.truncated).toBe(true);
      // The cut lines are still owed: the next cursor resumes after them.
      const resume = host.read("workshop:user:proj", result.firstSeq + result.lines.length - 1);
      expect(resume.lines.length).toBeGreaterThan(0);
      expect(resume.truncated).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a guarded kill never takes down a respawned session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const first = new FakeChild();
      const second = new FakeChild();
      let child = first;
      const host = new AcpHost({
        neutralBase: dir,
        resolveAdapterEntry: () => "/fake/adapter.js",
        spawnChild: () => child as never
      });
      const one = await host.spawn("workshop:user:proj", "proj");
      child = second;
      const two = await host.spawn("workshop:user:proj", "proj");
      expect(two.generation).toBeGreaterThan(one.generation);
      // Stale generation from a dropped connection: no-op, live session stands.
      host.kill("workshop:user:proj", one.generation);
      expect(host.read("workshop:user:proj", 0).exited).toBe(false);
      // Unconditional explicit kill still ends it: the record is gone.
      host.kill("workshop:user:proj");
      expect(() => host.read("workshop:user:proj", 0)).toThrow(/not running/);
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
