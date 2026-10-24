import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { captureFixture } from "./computer-capture-fixture.js";
import { captureManagedProcesses } from "../../scripts/computer-capture/run.js";
import { captureCgroupPair } from "../../scripts/computer-capture/cgroups.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const fixture = () => captureFixture((close) => cleanups.push(close));

export function afterCaptureOpen(
  f: Awaited<ReturnType<typeof fixture>>,
  action: (file: fs.FileHandle, path: string) => void
) {
  const open = vi.mocked(f.io.open).getMockImplementation()!;
  vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    action(file, String(args[0]));
    return file;
  });
}
describe("managed process snapshot: actual files/Unix Docker/child groups; disclosed OS cgroup/root projections", () => {
  it("durably samples init and different-group child without changing lock/state or leaking lifetime secret", async () => {
    const f = await fixture();
    const state = await fs.readFile(join(f.host.stateDir, "state.json"));
    const lock = await f.store.ownedLock();
    await f.run();
    const bytes = await fs.readFile(join(f.capture, "capture.json"), "utf8");
    const receipt = JSON.parse(bytes);
    expect(receipt).toMatchObject({
      version: 1,
      kind: "managed-process-snapshot",
      coverage: "sampled-cgroup-v2",
      watchdog: f.watchdog
    });
    expect(receipt.groups.pair[1].processes).toContainEqual({
      ...f.descendant,
      cgroup: f.groups[1] + "/child"
    });
    expect(f.descendant.processGroupId).not.toBe(f.desktop.processGroupId);
    expect(bytes).not.toContain(f.config.lifetime.secret);
    expect(await f.store.ownedLock()).toEqual(lock);
    expect(await fs.readFile(join(f.host.stateDir, "state.json"))).toEqual(state);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect((await f.nativeStat(join(f.capture, "capture.json"))).mode & 0o7777).toBe(0o600);
    await expect(f.run()).rejects.toThrow(); // Exclusive output, never overwrite.
  });
  it.each(["Paused", "Restarting", "Dead", "Pid", "StartedAt", "Status", "Running"])(
    "refuses malformed running State %s",
    async (key) => {
      const f = await fixture();
      Object.assign(f.containers[0]!.State, {
        [key]: ["Pid"].includes(key)
          ? 0
          : key === "StartedAt"
            ? "0001-01-01T00:00:00Z"
            : key === "Status"
              ? "exited"
              : key !== "Running"
      });
      await expect(f.run()).rejects.toThrow();
      expect(await fs.readdir(f.capture)).toEqual([]);
    }
  );
  it.each([
    "docker-pid",
    "docker-start",
    "membership",
    "process-group",
    "state-inode",
    "config-inode",
    "artifact",
    "journal",
    "lock",
    "stop",
    "signal",
    "capture-root"
  ])("rejects %s change after actual capture fsync and retains failed output", async (key) => {
    const f = await fixture();
    let injected = false;
    afterCaptureOpen(f, (file, path) => {
      if (!path.endsWith("/capture.json")) return;
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => {
        await sync();
        injected = true;
        if (key === "docker-pid") f.containers[0]!.State.Pid = f.descendant.pid;
        if (key === "docker-start") f.containers[0]!.State.StartedAt = "2026-10-24T01:00:00Z";
        if (key === "membership")
          await fs.writeFile(f.cgRoot + f.groups[1] + "/child/cgroup.procs", "");
        if (key === "process-group") {
          const identity = trust.processIdentity;
          vi.spyOn(trust, "processIdentity").mockImplementation(async (pid) => ({
            ...(await identity(pid)),
            ...(pid === f.descendant.pid ? { processGroupId: f.descendant.processGroupId + 1 } : {})
          }));
        }
        if (key === "state-inode" || key === "config-inode" || key === "lock") {
          const path =
            key === "config-inode"
              ? f.configPath
              : join(f.host.stateDir, key === "lock" ? "daemon.lock" : "state.json");
          const bytes = await fs.readFile(path);
          await fs.rename(path, path + ".retained");
          await fs.writeFile(path, bytes, { mode: 0o600 });
        }
        if (key === "artifact") await fs.writeFile(f.deployment.artifactPath, "changed");
        if (key === "journal")
          await fs.appendFile(join(f.config.monitor.path, "observation.jsonl"), "{}\n");
        if (key === "stop")
          await fs.writeFile(join(f.host.stateDir, "stop.json"), "{}", { mode: 0o600 });
        if (key === "signal") f.interrupt();
        if (key === "capture-root") {
          await fs.rename(f.capture, f.capture + ".retained");
          await fs.mkdir(f.capture, { mode: 0o700 });
        }
      });
    });
    await expect(f.run()).rejects.toThrow();
    expect(injected).toBe(true);
    expect(await fs.lstat(join(f.host.stateDir, "daemon.lock"))).toBeDefined();
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it.each(["file-sync", "directory-sync", "file-close", "directory-close"])(
    "requires actual %s acknowledgement",
    async (key) => {
      const f = await fixture();
      let injected = false;
      afterCaptureOpen(f, (file, path) => {
        if (key.startsWith("file") ? !path.endsWith("/capture.json") : path !== f.capture) return;
        // Only creation descriptor: subsequent readback is not the operation under test.
        if (key.startsWith("file") && injected) return;
        const method = key.endsWith("sync") ? "sync" : "close";
        const original = file[method].bind(file);
        vi.spyOn(file, method).mockImplementationOnce(async () => {
          await original();
          injected = true;
          throw new Error("disclosed persistence fault");
        });
      });
      await expect(f.run()).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await f.store.ownedLock()).toBeDefined();
    }
  );
  it("refuses absent store and foreign native watchdog before output", async () => {
    const f = await fixture();
    await expect(
      captureManagedProcesses(
        f.deployment,
        undefined,
        f.watchdog,
        f.startedAtMs,
        f.journal,
        () => false
      )
    ).rejects.toThrow();
    await expect(
      captureManagedProcesses(
        f.deployment,
        f.store,
        f.gateway,
        f.startedAtMs,
        f.journal,
        () => false
      )
    ).rejects.toThrow();
    expect(await fs.readdir(f.capture)).toEqual([]);
  });
  it.each([
    "duplicate",
    "foreign",
    "overlap",
    "host-member",
    "symlink",
    "oversize",
    "mount",
    "namespace"
  ])("rejects unsafe cgroup %s observations", async (key) => {
    const f = await fixture();
    if (key === "duplicate")
      await fs.appendFile(f.cgRoot + f.groups[0] + "/cgroup.procs", f.gateway.pid + "\n");
    if (key === "foreign") f.membership.set(f.gateway.pid, "/foreign");
    if (key === "overlap")
      f.membership.set(f.desktop.pid, f.groups[0]! + "/docker-" + f.resources[1]!.id + ".scope");
    if (key === "host-member") f.membership.set(process.pid, f.groups[0]!);
    if (key === "symlink")
      await fs.symlink(f.cgRoot + f.groups[0], f.cgRoot + f.groups[1] + "/alias");
    if (key === "oversize")
      await fs.writeFile(f.cgRoot + f.groups[0] + "/cgroup.procs", "1\n".repeat(8193));
    if (key === "mount") {
      const fake = join(f.root, "input/different-mount");
      await fs.writeFile(fake, "mnt_id:\t999999\n");
      const open = vi.mocked(f.io.open).getMockImplementation()!;
      vi.spyOn(f.io, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const match = /^\/proc\/self\/fdinfo\/(\d+)$/.exec(String(args[0]));
        const different =
          match && String(await fs.readlink(`/proc/self/fd/${match[1]}`)).endsWith("/cgroup.procs");
        return open(different ? fake : args[0], args[1], args[2]);
      });
    }
    if (key === "namespace") {
      const link = vi.mocked(f.io.readlink).getMockImplementation()!;
      vi.spyOn(f.io, "readlink").mockImplementation((path, ...args) =>
        String(path) === "/proc/1/ns/cgroup" ? Promise.resolve("cgroup:[123]") : link(path, ...args)
      );
    }
    await expect(
      captureCgroupPair(
        [
          { id: f.resources[0]!.id, pid: f.gateway.pid, role: "gateway" },
          { id: f.resources[1]!.id, pid: f.desktop.pid, role: "desktop" }
        ],
        [f.watchdog, f.config.runner]
      )
    ).rejects.toThrow();
  });
});
