import { spawn } from "node:child_process";
import { once } from "node:events";
import type { PathLike } from "node:fs";
import type * as fs from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import { provisionFixture } from "./computer-provision-fixture.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";
import { ObservationJournal } from "../../scripts/computer-watchdog/journal.js";
import { captureManagedProcesses } from "../../scripts/computer-capture/run.js";
import * as linux from "../../scripts/computer-watchdog/linux.js";

/** Actual children/groups, Unix Docker, files and persistence. Root/cgroup/heartbeat OS projections. */
export async function captureFixture(register: (close: () => Promise<void>) => void) {
  const f = await provisionFixture(register);
  const fs = f.io;
  const children: ReturnType<typeof spawn>[] = [];
  const owned: { store?: HostStateStore; journal?: ObservationJournal } = {};
  register(async () => {
    await Promise.allSettled([
      owned.journal?.close(),
      owned.store?.retainLock(),
      ...children.map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      })
    ]);
  });
  const child = async () => {
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached: true,
      stdio: "ignore"
    });
    children.push(c);
    await once(c, "spawn");
    return trust.processIdentity(c.pid!);
  };
  const gateway = await child(),
    desktop = await child(),
    descendant = await child();
  if ((await f.run()) !== 0) throw new Error("PREPARE fixture failed");
  const configPath = join(f.configuration.output.path, "supervisor.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const capture = join(f.root, "capture");
  await fs.mkdir(capture, { mode: 0o700 });
  const { dev, ino, uid, gid, mode } = await fs.lstat(capture);
  config.capture = { path: capture, dev, ino, uid, gid, mode };
  await fs.writeFile(configPath, JSON.stringify(config));
  for (let i = 0; i < 2; i++)
    Object.assign(f.containers[i]!.State, {
      Running: true,
      Status: "running",
      Pid: i === 0 ? gateway.pid : desktop.pid,
      StartedAt: "2026-10-24T00:00:00.123456789Z",
      Restarting: false,
      Paused: false,
      Dead: false
    });
  const cgRoot = join(f.root, "cgroups");
  const groups = [
    "/system.slice/docker-" + f.resources[0]!.id + ".scope",
    "/system.slice/docker-" + f.resources[1]!.id + ".scope"
  ];
  const membership = new Map([
    [gateway.pid, groups[0]!],
    [desktop.pid, groups[1]!],
    [descendant.pid, groups[1]! + "/child"]
  ]);
  for (const [path, pids] of [
    [groups[0], [gateway.pid]],
    [groups[1], [desktop.pid]],
    [groups[1] + "/child", [descendant.pid]]
  ] as const) {
    await fs.mkdir(cgRoot + path, { recursive: true, mode: 0o755 });
    await fs.writeFile(cgRoot + path + "/cgroup.procs", pids.join("\n") + "\n", { mode: 0o644 });
  }
  const mapPath = (path: PathLike) =>
    String(path).startsWith("/sys/fs/cgroup") ? cgRoot + String(path).slice(14) : path;
  const ownInfo = join(f.root, "input/own-info");
  await fs.writeFile(ownInfo, "flags:\t00\n");
  const heartbeatInfo = join(f.root, "input/heartbeat-info");
  await fs.writeFile(heartbeatInfo, "flags:\t01\n");
  const open = vi.mocked(fs.open).getMockImplementation()!;
  vi.spyOn(fs, "open").mockImplementation((path, flags, mode) =>
    open(
      String(path) === "/proc/self/fdinfo/0"
        ? ownInfo
        : String(path) === `/proc/${config.runner.pid}/fdinfo/0`
          ? heartbeatInfo
          : mapPath(path),
      flags,
      mode
    )
  );
  const lstat = vi.mocked(fs.lstat).getMockImplementation()!;
  vi.spyOn(fs, "lstat").mockImplementation((...args: Parameters<typeof fs.lstat>) =>
    lstat(mapPath(args[0]), ...(args.slice(1) as []))
  );
  const realpath = fs.realpath;
  vi.spyOn(fs, "realpath").mockImplementation((...args: Parameters<typeof fs.realpath>) =>
    String(args[0]).startsWith("/sys/fs/cgroup")
      ? Promise.resolve(String(args[0]))
      : realpath(...args)
  );
  const statfs = fs.statfs;
  vi.spyOn(fs, "statfs").mockImplementation(async (...args: Parameters<typeof fs.statfs>) => {
    const result = await statfs(...args);
    if (String(args[0]) === "/sys/fs/cgroup") result.type = 0x63677270n;
    return result;
  });
  const ns = {
    net: await fs.readlink("/proc/self/ns/net"),
    cgroup: await fs.readlink("/proc/self/ns/cgroup")
  };
  const link = vi.mocked(fs.readlink).getMockImplementation()!;
  vi.spyOn(fs, "readlink").mockImplementation((path, ...args) => {
    const value = String(path);
    if (
      [
        "/proc/self/fd/1",
        "/proc/self/fd/2",
        `/proc/${process.pid}/fd/1`,
        `/proc/${process.pid}/fd/2`
      ].includes(value)
    )
      return Promise.resolve("/dev/null");
    if (["/proc/self/fd/0", `/proc/${config.runner.pid}/fd/0`].includes(value))
      return Promise.resolve("pipe:[123456]");
    if (value.startsWith("/proc/1/ns/") && value.split("/").at(-1)! in ns)
      return Promise.resolve(ns[value.split("/").at(-1) as keyof typeof ns]);
    return link(path, ...args);
  });
  const bounded = trust.boundedFile;
  vi.spyOn(trust, "boundedFile").mockImplementation((path, limit) => {
    if (path === "/proc/self/fdinfo/0") return Promise.resolve(Buffer.from("flags:\t00\n"));
    if (path === `/proc/${config.runner.pid}/fdinfo/0`)
      return Promise.resolve(Buffer.from("flags:\t01\n"));
    const pid = /^\/proc\/(\d+)\/cgroup$/.exec(path);
    if (pid)
      return Promise.resolve(
        Buffer.from(`0::${membership.get(Number(pid[1])) ?? "/host.slice"}\n`)
      );
    return bounded(path, limit);
  });
  const deployment = await trust.loadSupervisorDeployment(
    configPath,
    f.configuration.supervisorArtifactPath
  );
  const store = (owned.store = await HostStateStore.openExisting(f.host, {
    retainFailedLock: true
  }));
  const watchdog = await trust.processIdentity(process.pid);
  const startedAtMs = linux.computerMonotonicMs();
  let now = startedAtMs;
  vi.spyOn(linux, "computerMonotonicMs").mockImplementation(() => now);
  const journal = (owned.journal = await ObservationJournal.create(config.monitor, {
    runId: config.runId,
    startedAtMs,
    runner: config.runner,
    watchdog
  }));
  let interrupted = false;
  const run = () =>
    captureManagedProcesses(deployment, store, watchdog, startedAtMs, journal!, () => interrupted);
  f.calls.length = 0;
  return {
    ...f,
    deployment,
    store,
    journal,
    watchdog,
    startedAtMs,
    capture,
    configPath,
    config,
    cgRoot,
    groups,
    membership,
    gateway,
    desktop,
    descendant,
    run,
    setNow: (value: number) => {
      now = value;
    },
    interrupt: () => {
      interrupted = true;
    }
  };
}
