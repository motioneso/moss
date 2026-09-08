/**
 * AcpHost (#2369 slice 1): spawns the ACP adapter under the session identity and
 * pipes its stdio lines. Uses spawnChild injection so these tests are
 * pure/fast/deterministic — no real processes, no timers left dangling.
 */
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AcpHost, defaultResolveAdapterTarget } from "../../packages/cli-runner/src/acp-host.js";

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
  const homeBase = join(dir, "homes");
  mkdirSync(homeBase, { recursive: true });
  const host = new AcpHost({
    neutralBase: dir,
    homeBase,
    perUserUid: true,
    resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
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
      const spawned = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
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
      const other = await host.spawn("workshop:user:proj", "other", "anthropic", "user-1", "chat");
      expect(other.cwd).not.toBe(spawned.cwd);
      expect(spawned.cwd.startsWith(other.cwd)).toBe(false);
      expect(other.cwd.startsWith(spawned.cwd)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes no Claude deny list: the table is the single source now", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      // Task 5b deleted the host-written deny file; per-row mechanisms from
      // the table (client flag, launch env, home settings file) replaced it.
      expect(existsSync(join(spawned.cwd, ".claude", "settings.json"))).toBe(false);
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
      const spawned = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
      expect(mode(spawned.cwd)).toBe("700");

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
          resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
          spawnChild: () => child as never
        });
        await loud.spawn("workshop:user:proj2", "proj", "anthropic", "user-1", "chat");
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
      await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
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
      const homeBase = join(dir, "homes");
      mkdirSync(homeBase, { recursive: true });
      const host = new AcpHost({
        neutralBase: dir,
        homeBase,
        perUserUid: true,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never
      });
      const one = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      child = second;
      const two = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
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

  it("replaces a planted link with a real folder on the start path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const victim = mkdtempSync(join(tmpdir(), "acp-victim-"));
      try {
        const canary = join(victim, "canary.txt");
        writeFileSync(canary, "untouched");
        chmodSync(victim, 0o755);
        // A previous command swaps its own project folder for a link elsewhere.
        const sessionDir = join(dir, "workshop:user:proj", "acp", "proj");
        mkdirSync(join(sessionDir, ".."), { recursive: true });
        symlinkSync(victim, sessionDir);

        const child = new FakeChild();
        const { host } = makeHost(dir, child);
        const spawned = await host.spawn(
          "workshop:user:proj",
          "proj",
          "anthropic",
          "user-1",
          "chat"
        );

        // The link is gone, a real folder stands in its place, and the spawn landed there.
        expect(lstatSync(sessionDir).isSymbolicLink()).toBe(false);
        expect(lstatSync(sessionDir).isDirectory()).toBe(true);
        expect(spawned.cwd).toBe(sessionDir);
        // The victim was never followed: file intact, permissions unchanged.
        expect(readFileSync(canary, "utf8")).toBe("untouched");
        expect(statSync(victim).mode & 0o777).toBe(0o755);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a planted link at a parent folder on the start path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const victim = mkdtempSync(join(tmpdir(), "acp-victim-"));
      try {
        // A previous command swaps a parent of the project folder for a link.
        mkdirSync(join(dir, "workshop:user:proj"), { recursive: true });
        symlinkSync(victim, join(dir, "workshop:user:proj", "acp"));

        const child = new FakeChild();
        const { host } = makeHost(dir, child);
        const spawned = await host.spawn(
          "workshop:user:proj",
          "proj",
          "anthropic",
          "user-1",
          "chat"
        );

        // Every level is real, the spawn landed in the real folder, and
        // nothing was ever created inside the victim.
        const sessionDir = join(dir, "workshop:user:proj", "acp", "proj");
        expect(lstatSync(join(dir, "workshop:user:proj", "acp")).isSymbolicLink()).toBe(false);
        expect(spawned.cwd).toBe(sessionDir);
        expect(readdirSync(victim)).toHaveLength(0);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a project id that could escape the session folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await expect(
        host.spawn("workshop:user:proj", "../evil", "anthropic", "user-1", "chat")
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects multiline sends and reports exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
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

  it("resolves each row to its own pinned package entry, and refuses a spawn without a kind", async () => {
    const claude = defaultResolveAdapterTarget("anthropic");
    expect(claude.command).toBe(process.execPath);
    expect(claude.args[0]).toContain("@agentclientprotocol/claude-agent-acp");

    const codex = defaultResolveAdapterTarget("openai");
    expect(codex.command).toBe(process.execPath);
    expect(codex.args[0]).toContain("@agentclientprotocol/codex-acp");

    const opencode = defaultResolveAdapterTarget("opencode");
    expect(opencode.command).toContain("opencode-ai");
    expect(opencode.command.endsWith(join("bin", "opencode.exe"))).toBe(true);
    expect(opencode.args).toEqual(["acp"]);
    expect(() => defaultResolveAdapterTarget("unknown" as never)).toThrow();

    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      await expect(
        host.spawn("workshop:user:proj", "proj", undefined as never, "user-1", "chat")
      ).rejects.toThrow(/providerKind/);
      await expect(
        host.spawn("workshop:user:proj", "proj", "anthropic", undefined as never, "chat")
      ).rejects.toThrow(/userId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task 5b launch follows the row", () => {
  function makeUserHost(neutralBase: string, homeBase: string, child: FakeChild) {
    const seen: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> =
      [];
    const host = new AcpHost({
      neutralBase,
      homeBase,
      perUserUid: true,
      resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
      spawnChild: (opts) => {
        seen.push({ command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env });
        return child as never;
      }
    });
    return { host, seen };
  }

  it("allocates one slot per person across conversations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      const { host, seen } = makeUserHost(dir, home, child);
      await host.spawn("chat:user-1:aaa", "proj", "anthropic", "user-1", "chat");
      await host.spawn("chat:user-1:bbb", "proj", "anthropic", "user-1", "chat");
      const slots = JSON.parse(readFileSync(join(home, "uid-slots.json"), "utf8")) as Record<
        string,
        number
      >;
      // One entry for the person, not one per conversation.
      expect(Object.keys(slots)).toEqual(["user-1"]);
      expect(seen).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs the agent in the slot's own home, never the shared base", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      const { host, seen } = makeUserHost(dir, home, child);
      const spawned = await host.spawn("chat:user-1:aaa", "proj", "anthropic", "user-1", "chat");
      expect(spawned.home).toBe(join(home, "agents", "user-1"));
      expect(seen[0]?.env.HOME).toBe(join(home, "agents", "user-1"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("passes the Claude token to Claude alone, read-only to Codex, neither elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      mkdirSync(join(home, ".jarvis", "cli-tokens"), { recursive: true });
      writeFileSync(join(home, ".jarvis", "cli-tokens", "anthropic"), "tok_test-token");
      const child = new FakeChild();
      const { host, seen } = makeUserHost(dir, home, child);
      // Ready rows run under either profile; not-ready rows refuse chat, so
      // the per-row environment is observed through Workshop here.
      await host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat");
      await host.spawn("chat:user-1:b", "proj", "openai", "user-1", "workshop");
      await host.spawn("chat:user-1:c", "proj", "opencode", "user-1", "workshop");
      expect(seen[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok_test-token");
      expect(seen[1]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(seen[1]?.env.INITIAL_AGENT_MODE).toBe("read-only");
      expect(seen[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(seen[2]?.env.INITIAL_AGENT_MODE).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the OpenCode deny file from the table, preserving the rest", async () => {
    // The writer runs at spawn for chat; with the row not ready the spawn
    // itself refuses, so this test drives the writer directly. Task 10 proves
    // the wired path in the real per-user home.
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      // A login-owned config the write must preserve, not clobber.
      const existingDir = join(home, "agents", "user-1", ".config", "opencode");
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(
        join(existingDir, "opencode.json"),
        JSON.stringify({ model: "keep-me", permission: { read: "allow" } })
      );
      const { writeOpencodeChatDenyFile } =
        await import("../../packages/cli-runner/src/owned-fs.js");
      await writeOpencodeChatDenyFile(
        join(home, "agents", "user-1"),
        "user-1",
        undefined,
        undefined
      );
      const written = JSON.parse(
        readFileSync(join(home, "agents", "user-1", ".config", "opencode", "opencode.json"), "utf8")
      ) as { model?: string; permission?: Record<string, string> };
      const { opencodeDenyPermissionKeys } = await import("../../packages/acp/src/providers.js");
      const expected = opencodeDenyPermissionKeys();
      expect(expected).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
      for (const key of expected) expect(written.permission?.[key]).toBe("deny");
      expect(written.model).toBe("keep-me");
      expect(written.permission?.read).toBe("allow");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes no deny file for Workshop sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      const { host } = makeUserHost(dir, home, child);
      await host.spawn("workshop:user-1:b", "proj", "opencode", "user-1", "workshop");
      expect(
        existsSync(join(home, "agents", "user-1", ".config", "opencode", "opencode.json"))
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("identity off refuses before any slot or file work", () => {
  it("refuses the launch and writes no file anywhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never
      });
      await expect(
        host.spawn("chat:user-1:a", "proj", "anthropic", "user-1", "chat")
      ).rejects.toThrow(/per-user identity/);
      // No slot was allocated and no deny file was written, here or anywhere.
      expect(existsSync(join(home, "uid-slots.json"))).toBe(false);
      expect(existsSync(join(home, "agents"))).toBe(false);
      expect(existsSync(join(dir, "chat:user-1:a"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("not-ready rows refuse at the launcher", () => {
  it("refuses a not-ready row with Not logged in and no side effects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      let spawned = 0;
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        perUserUid: true,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => {
          spawned += 1;
          return child as never;
        }
      });
      await expect(host.spawn("chat:user-1:a", "proj", "openai", "user-1", "chat")).rejects.toThrow(
        /Not logged in/
      );
      await expect(
        host.spawn("chat:user-1:a", "proj", "opencode", "user-1", "chat")
      ).rejects.toThrow(/Not logged in/);
      expect(spawned).toBe(0);
      expect(existsSync(join(home, "uid-slots.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
