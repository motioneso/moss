/**
 * AcpHost (#2369 slice 1): spawns the ACP adapter under the session identity and
 * pipes its stdio lines. Uses spawnChild injection so these tests are
 * pure/fast/deterministic — no real processes, no timers left dangling.
 */
import { spawnSync } from "node:child_process";
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
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AcpHost,
  defaultResolveAdapterTarget,
  type AgentHomePrepareRequest,
  type AgentHomeSecretFile
} from "../../packages/cli-runner/src/acp-host.js";
import { allocateUidSlot as realAllocateUidSlot } from "../../packages/cli-runner/src/uid-allocator.js";

// These tests exercise spawn routing (folders, env, deny files), not the real
// chown privilege boundary. Rather than stub the handover out, they give the
// host the test process's own real uid/gid as the "slot" identity: chowning
// a file to your own current uid/gid always succeeds unprivileged, so the
// real default handover genuinely runs and a reused top level is genuinely,
// not just pretend, owned by the identity the host checks against. The
// refusal-on-real-failure behavior is proved separately, against a
// genuinely unreachable id, in cli-runner-owned-fs.test.ts and in the
// "locks session folders..." test below (which deliberately keeps the real
// slot allocator for its second host).
const selfSlot = (): { uid: number; gid: number } => ({
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0
});

// Same real per-person slot bookkeeping as production (so a test can prove
// "one entry per person" against the real slot file), but handed back as the
// test process's own uid/gid so an unprivileged chown can genuinely succeed.
const selfSlotWithRealFile = (homeBase: string, userId: string): { uid: number; gid: number } => {
  realAllocateUidSlot(homeBase, userId);
  return selfSlot();
};

// Stands in for the real setpriv+node preparation step (task 5b, Architect
// ruling, 2026-09-08): these tests run unprivileged, so this fake does the
// same folder/deny-file work plainly, without ever switching identity. It
// It walks folder levels without writing through planted symlinks. The real
// owner-switched step is exercised in its own credential-boundary tests.
function ensureRealDirSync(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false }) ?? null;
  if (stat?.isSymbolicLink()) rmSync(path, { force: true });
  if (!stat || stat.isSymbolicLink()) {
    mkdirSync(path, { mode: 0o700 });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`refusing to prepare ${path}: not a real folder`);
}

function ensureDirTreeSync(path: string): void {
  const parts = path.split("/").filter((part) => part.length > 0);
  let current = path.startsWith("/") ? "/" : "";
  for (const part of parts) {
    current = current === "" ? part : current === "/" ? `/${part}` : `${current}/${part}`;
    ensureRealDirSync(current);
  }
}

type AgentHomePrepare = (
  request: AgentHomePrepareRequest,
  identity: { uid: number; gid: number },
  secretFiles?: readonly AgentHomeSecretFile[]
) => Promise<void>;

async function fakeAgentHomePrepare(request: AgentHomePrepareRequest): Promise<void> {
  for (const dir of request.dirs) ensureDirTreeSync(dir);
  if (request.denyFile) {
    const { path, permissionKeys } = request.denyFile;
    const first = lstatSync(path, { throwIfNoEntry: false }) ?? null;
    if (first?.isSymbolicLink()) rmSync(path, { force: true });
    let config: Record<string, unknown> = {};
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    }
    const prior = config.permission;
    const permission: Record<string, unknown> =
      prior && typeof prior === "object" && !Array.isArray(prior) ? { ...prior } : {};
    for (const key of permissionKeys) permission[key] = "deny";
    config.permission = permission;
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
}

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

// setpriv --clear-groups needs a real root process (see engine-host-types.ts's
// perUserUid doc comment), so an unprivileged test process can never make the
// real purge subprocess succeed. This fake proves the purge is called with the
// right folder and identity by actually deleting the folder itself, without
// going through setpriv.
const fakePurgePrivateFolder = async (
  cwd: string,
  _identity: { readonly uid: number; readonly gid: number } | null
): Promise<void> => {
  await rm(cwd, { recursive: true, force: true });
};

function makeHost(dir: string, child: FakeChild) {
  let lastSpawn: { cwd: string; env: NodeJS.ProcessEnv } | null = null;
  const homeBase = join(dir, "homes");
  mkdirSync(homeBase, { recursive: true });
  const host = new AcpHost({
    neutralBase: dir,
    homeBase,
    perUserUid: true,
    allocateUidSlot: selfSlot,
    resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
    spawnChild: (opts) => {
      lastSpawn = { cwd: opts.cwd, env: opts.env };
      return child as never;
    },
    runAgentHomePrepare: fakeAgentHomePrepare,
    purgePrivateFolder: fakePurgePrivateFolder
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

  it("locks session folders owner-only and refuses the launch when it cannot hand one over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      const mode = (path: string): string => (statSync(path).mode & 0o777).toString(8);
      expect(mode(spawned.cwd)).toBe("700");

      // With per-user identity on but no real chown privilege, the handover
      // fails — task 5b makes that stop the launch there, folder removed,
      // rather than warning and carrying on.
      mkdirSync(join(dir, "homes"), { recursive: true });
      const strict = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never
      });
      // A fresh person ("user-2"): the first host's own real uid/gid never
      // touched this one, so this is a genuinely new top level, and the real
      // (unmocked) slot allocator hands out a synthetic uid/gid this test
      // process can never really chown to.
      await expect(
        strict.spawn("workshop:user:proj2", "proj", "anthropic", "user-2", "chat")
      ).rejects.toThrow(/could not hand.*to its owner, launch refused/);
      expect(existsSync(join(dir, "workshop:user:proj2"))).toBe(false);
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
        allocateUidSlot: selfSlot,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never,
        runAgentHomePrepare: fakeAgentHomePrepare
      });
      const one = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      child = second;
      const two = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      expect(two.generation).toBeGreaterThan(one.generation);
      // Stale generation from a dropped connection: no-op, live session stands.
      await host.kill("workshop:user:proj", one.generation);
      expect(host.read("workshop:user:proj", 0).exited).toBe(false);
      // Unconditional explicit kill still ends it: the record is gone. Awaited
      // because a chat-profile kill now also purges the scratch folder before
      // dropping the record.
      await host.kill("workshop:user:proj");
      expect(() => host.read("workshop:user:proj", 0)).toThrow(/not running/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a chat session's scratch folder for purge, and writes no marker for workshop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const chatChild = new FakeChild();
      const { host: chatHost } = makeHost(dir, chatChild);
      const spawned = await chatHost.spawn(
        "workshop:user:proj",
        "proj",
        "anthropic",
        "user-1",
        "chat"
      );
      const markerPath = join(dir, "acp-private-markers", "workshop:user:proj.json");
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
        cwd: string;
        home: string;
        uid: number;
        gid: number;
      };
      expect(marker.cwd).toBe(spawned.cwd);
      expect(marker.home).toBe(spawned.home);

      const workshopChild = new FakeChild();
      const { host: workshopHost } = makeHost(dir, workshopChild);
      await workshopHost.spawn("workshop:user:other", "proj", "anthropic", "user-1", "workshop");
      expect(existsSync(join(dir, "acp-private-markers", "workshop:user:other.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("purges a chat session's scratch folder and removes its marker once the kill confirms exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn("workshop:user:proj", "proj", "anthropic", "user-1", "chat");
      expect(existsSync(spawned.cwd)).toBe(true);
      child.exit(0);
      await host.kill("workshop:user:proj");
      expect(existsSync(spawned.cwd)).toBe(false);
      expect(existsSync(join(dir, "acp-private-markers", "workshop:user:proj.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a workshop session's real project folder in place on kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const child = new FakeChild();
      const { host } = makeHost(dir, child);
      const spawned = await host.spawn(
        "workshop:user:proj",
        "proj",
        "anthropic",
        "user-1",
        "workshop"
      );
      child.exit(0);
      await host.kill("workshop:user:proj");
      expect(existsSync(spawned.cwd)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep purges a leftover marker once its process is confirmed gone, removing the marker only on success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const { writeAcpPrivateMarker } =
        await import("../../packages/cli-runner/src/acp-private-markers.js");
      const orphanFolder = join(dir, "orphan-scratch");
      mkdirSync(orphanFolder, { recursive: true });
      writeFileSync(join(orphanFolder, "leftover.txt"), "stale");
      // A pid + start time from a process that has already fully exited and been
      // reaped: readProcStatus for it reads "gone", so the sweep may purge without
      // sending a stop signal anywhere.
      const goneChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      const goneStartTime = String(goneChild.pid);
      await writeAcpPrivateMarker(dir, "workshop:orphan:proj", {
        sessionKey: "workshop:orphan:proj",
        cwd: orphanFolder,
        home: join(dir, "homes", "agents", "user-1"),
        provider: "anthropic",
        pid: goneChild.pid ?? -1,
        startTime: goneStartTime,
        ...selfSlot()
      });

      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        purgePrivateFolder: fakePurgePrivateFolder,
        readProcStatus: () => ({ kind: "gone" })
      });
      const allPurged = await host.sweepPrivateMarkers();
      expect(allPurged).toBe(true);
      expect(existsSync(orphanFolder)).toBe(false);
      expect(existsSync(join(dir, "acp-private-markers", "workshop:orphan:proj.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep leaves a marker with no recorded process untouched instead of purging it (Astra finding 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const { writeAcpPrivateMarker } =
        await import("../../packages/cli-runner/src/acp-private-markers.js");
      const orphanFolder = join(dir, "orphan-scratch");
      mkdirSync(orphanFolder, { recursive: true });
      writeFileSync(join(orphanFolder, "leftover.txt"), "stale");
      // A marker written between spawn and the pid/start-time backfill (or one whose
      // backfill write itself failed) names no process to confirm stopped.
      await writeAcpPrivateMarker(dir, "workshop:orphan:proj", {
        sessionKey: "workshop:orphan:proj",
        cwd: orphanFolder,
        home: join(dir, "homes", "agents", "user-1"),
        provider: "anthropic",
        pid: null,
        startTime: null,
        ...selfSlot()
      });

      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        purgePrivateFolder: fakePurgePrivateFolder
      });
      const allPurged = await host.sweepPrivateMarkers();
      expect(allPurged).toBe(false);
      expect(existsSync(orphanFolder)).toBe(true);
      expect(existsSync(join(dir, "acp-private-markers", "workshop:orphan:proj.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep never purges when the process's status could not be confirmed (Astra finding 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const { writeAcpPrivateMarker } =
        await import("../../packages/cli-runner/src/acp-private-markers.js");
      const orphanFolder = join(dir, "orphan-scratch");
      mkdirSync(orphanFolder, { recursive: true });
      writeFileSync(join(orphanFolder, "leftover.txt"), "stale");
      await writeAcpPrivateMarker(dir, "workshop:orphan:proj", {
        sessionKey: "workshop:orphan:proj",
        cwd: orphanFolder,
        home: join(dir, "homes", "agents", "user-1"),
        provider: "anthropic",
        pid: 999999,
        startTime: "123456",
        ...selfSlot()
      });

      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        purgePrivateFolder: fakePurgePrivateFolder,
        // A reader that can neither confirm the process is gone nor that it is
        // still running with the recorded start time — a fail-closed sweep must
        // never treat this the same as "confirmed stopped".
        readProcStatus: () => ({ kind: "unknown" })
      });
      const allPurged = await host.sweepPrivateMarkers();
      expect(allPurged).toBe(false);
      expect(existsSync(orphanFolder)).toBe(true);
      expect(existsSync(join(dir, "acp-private-markers", "workshop:orphan:proj.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep skips a marker whose content is the literal JSON null and still processes the rest (Astra finding 4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const { writeAcpPrivateMarker } =
        await import("../../packages/cli-runner/src/acp-private-markers.js");
      const markersDir = join(dir, "acp-private-markers");
      mkdirSync(markersDir, { recursive: true });
      writeFileSync(join(markersDir, "workshop:null-marker:proj.json"), "null");

      const orphanFolder = join(dir, "orphan-scratch");
      mkdirSync(orphanFolder, { recursive: true });
      writeFileSync(join(orphanFolder, "leftover.txt"), "stale");
      const goneChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      await writeAcpPrivateMarker(dir, "workshop:orphan:proj", {
        sessionKey: "workshop:orphan:proj",
        cwd: orphanFolder,
        home: join(dir, "homes", "agents", "user-1"),
        provider: "anthropic",
        pid: goneChild.pid ?? -1,
        startTime: String(goneChild.pid),
        ...selfSlot()
      });

      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        purgePrivateFolder: fakePurgePrivateFolder,
        readProcStatus: () => ({ kind: "gone" })
      });
      // The literal-null marker must not throw past the caller and abort the
      // rest of the sweep — the other, valid marker still gets processed.
      const allPurged = await host.sweepPrivateMarkers();
      expect(allPurged).toBe(false);
      expect(existsSync(join(markersDir, "workshop:null-marker:proj.json"))).toBe(true);
      expect(existsSync(orphanFolder)).toBe(false);
      expect(existsSync(join(dir, "acp-private-markers", "workshop:orphan:proj.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boot sweep purges only this session's own Codex transcripts, matched by its recorded working folder (Astra finding 3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-host-"));
    try {
      const { writeAcpPrivateMarker } =
        await import("../../packages/cli-runner/src/acp-private-markers.js");
      const orphanFolder = join(dir, "orphan-scratch");
      mkdirSync(orphanFolder, { recursive: true });
      const home = join(dir, "homes", "agents", "user-1");
      const goneChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      await writeAcpPrivateMarker(dir, "workshop:orphan:proj", {
        sessionKey: "workshop:orphan:proj",
        cwd: orphanFolder,
        home,
        provider: "openai",
        pid: goneChild.pid ?? -1,
        startTime: String(goneChild.pid),
        ...selfSlot()
      });

      const purged: Array<{ home: string; cwd: string }> = [];
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: join(dir, "homes"),
        perUserUid: true,
        purgePrivateFolder: fakePurgePrivateFolder,
        readProcStatus: () => ({ kind: "gone" }),
        purgeCodexTranscripts: async (purgeHome, purgeCwd) => {
          purged.push({ home: purgeHome, cwd: purgeCwd });
        }
      });
      const allPurged = await host.sweepPrivateMarkers();
      expect(allPurged).toBe(true);
      // Asked for by this session's own home and working folder, never a
      // whole dated Codex sessions folder shared with other conversations.
      expect(purged).toEqual([{ home, cwd: orphanFolder }]);
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
  function makeUserHost(
    neutralBase: string,
    homeBase: string,
    child: FakeChild,
    runAgentHomePrepare: AgentHomePrepare = async (request) => fakeAgentHomePrepare(request)
  ) {
    const seen: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> =
      [];
    const host = new AcpHost({
      neutralBase,
      homeBase,
      perUserUid: true,
      allocateUidSlot: selfSlotWithRealFile,
      resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
      spawnChild: (opts) => {
        seen.push({ command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env });
        return child as never;
      },
      runAgentHomePrepare
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
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      writeFileSync(
        join(home, "agents", "user-1", ".codex", "auth.json"),
        JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture" } })
      );
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

  it("uses each user's Codex auth, never another user's credential or the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const authByUser = {
        "user-a": JSON.stringify({ tokens: { access_token: "token-a", account_id: "account-a" } }),
        "user-b": JSON.stringify({ tokens: { access_token: "token-b", account_id: "account-b" } })
      };
      for (const [userId, auth] of Object.entries(authByUser)) {
        const source = join(home, "agents", userId, ".codex");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "auth.json"), auth, { mode: 0o600 });
      }
      const child = new FakeChild();
      const handedOff: Array<readonly AgentHomeSecretFile[]> = [];
      const { host, seen } = makeUserHost(dir, home, child, async (request, identity, files) => {
        handedOff.push(files ?? []);
        await fakeAgentHomePrepare(request);
      });
      const first = await host.spawn("chat:user-a:codex", "proj", "openai", "user-a", "chat");
      const second = await host.spawn("chat:user-b:codex", "proj", "openai", "user-b", "chat");
      expect(handedOff.map((files) => files.map(({ path }) => path))).toEqual([
        [join(home, "agents", "user-a", ".codex", "auth.json")],
        [join(home, "agents", "user-b", ".codex", "auth.json")]
      ]);
      expect(handedOff[0]?.[0]?.sourcePath).toBe(
        join(home, "agents", "user-a", ".codex", "auth.json")
      );
      expect(handedOff[1]?.[0]?.sourcePath).toBe(
        join(home, "agents", "user-b", ".codex", "auth.json")
      );
      expect(seen[0]?.env.HOME).toBe(first.home);
      expect(seen[1]?.env.HOME).toBe(second.home);
      expect(seen.every(({ env }) => env.CODEX_HOME === undefined)).toBe(true);
      expect(seen.every(({ env }) => env.CLAUDE_CODE_OAUTH_TOKEN === undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the OpenCode deny file from the table, preserving the rest", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const existingDir = join(home, "agents", "user-1", ".config", "opencode");
      mkdirSync(existingDir, { recursive: true });
      writeFileSync(
        join(existingDir, "opencode.json"),
        JSON.stringify({ model: "keep-me", permission: { read: "allow" } })
      );
      const { opencodeDenyPermissionKeys } = await import("../../packages/acp/src/providers.js");
      const expected = opencodeDenyPermissionKeys();
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const request = JSON.stringify({
        dirs: [existingDir],
        denyFile: { path: join(existingDir, "opencode.json"), permissionKeys: expected }
      });
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(process.execPath, [scriptPath, request], { encoding: "utf8" });
      expect(result.status).toBe(0);
      const written = JSON.parse(
        readFileSync(join(home, "agents", "user-1", ".config", "opencode", "opencode.json"), "utf8")
      ) as { model?: string; permission?: Record<string, string> };
      expect(expected).toEqual(expect.arrayContaining(["bash", "edit", "write"]));
      for (const key of expected) expect(written.permission?.[key]).toBe("deny");
      expect(written.model).toBe("keep-me");
      expect(written.permission?.read).toBe("allow");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes secret preparation files from stdin with owner-only mode", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const target = join(home, "agents", "user-1", ".codex", "auth.json");
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const { spawnSync } = await import("node:child_process");
      mkdirSync(join(home, "agents", "user-1", ".codex"), { recursive: true });
      writeFileSync(target, "old-auth", { mode: 0o644 });
      const result = spawnSync(
        process.execPath,
        [scriptPath, JSON.stringify({ dirs: [], denyFile: null })],
        {
          encoding: "utf8",
          input: JSON.stringify([{ path: target, content: "fixture-auth" }])
        }
      );
      expect(result.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("fixture-auth");
      expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails loudly and preserves malformed existing settings", async () => {
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const configDir = join(home, "config");
      const configPath = join(configDir, "opencode.json");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, "{ not-json");
      const scriptPath = join(process.cwd(), "packages/cli-runner/src/agent-home-prepare.mjs");
      const request = JSON.stringify({
        dirs: [configDir],
        denyFile: { path: configPath, permissionKeys: ["bash"] }
      });
      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(process.execPath, [scriptPath, request], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe("{ not-json");
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

  it("fails without leaving a fresh agent home when session setup fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-5b-"));
    const home = mkdtempSync(join(tmpdir(), "acp-5b-home-"));
    try {
      const child = new FakeChild();
      let handovers = 0;
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        perUserUid: true,
        allocateUidSlot: selfSlot,
        applyOwnership: async () => {
          handovers += 1;
          if (handovers === 2) throw new Error("session handover failed");
        },
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child as never
      });

      await expect(
        host.spawn("chat:user-1:setup-fails", "proj", "anthropic", "user-1", "chat")
      ).rejects.toThrow("session handover failed");
      expect(existsSync(join(home, "agents", "user-1"))).toBe(false);
      expect(existsSync(join(dir, "chat:user-1:setup-fails"))).toBe(false);
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
      const host = new AcpHost({
        neutralBase: dir,
        homeBase: home,
        perUserUid: true,
        allocateUidSlot: selfSlot,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        runAgentHomePrepare: async () => {
          throw new Error("missing Codex login");
        }
      });
      await expect(host.spawn("chat:user-1:a", "proj", "openai", "user-1", "chat")).rejects.toThrow(
        /missing Codex login/
      );
      expect(existsSync(join(home, "uid-slots.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
