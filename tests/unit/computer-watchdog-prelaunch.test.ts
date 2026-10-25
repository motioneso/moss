import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectRoots } from "../../scripts/computer-host/config.js";
import { runWatchdog, type WatchdogDeps } from "../../scripts/computer-watchdog/main.js";
import {
  loadPrelaunchDeployment,
  loadSupervisorDeployment,
  parsePrelaunchConfiguration,
  parseSupervisorConfiguration,
  processIdentity,
  sha256,
  type PrelaunchDeployment,
  type SupervisorDeployment
} from "../../scripts/computer-watchdog/trust.js";
import { isolatedConfig } from "./computer-host-fixture.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});

type Json = Record<string, unknown>;
interface Fixture {
  readonly dir: string;
  readonly artifact: string;
  readonly configPath: string;
  readonly supervisor: Json;
  readonly prelaunch: Json;
  readonly socketPath: string;
  readonly controlDir: string;
  readonly stateDir: string;
  readonly runnerPid: number;
  /** Paths whose metadata reads back as owned by a non-root user. */
  readonly untrusted: Set<string>;
  /** Replaces what readlink reports for a path. */
  readonly links: Map<string, string>;
  /** Replaces the file opened for a path. */
  readonly files: Map<string, string>;
  write(value: Json): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const host = await isolatedConfig();
  cleanups.push(() => host.close());
  const dir = await mkdtemp(join(tmpdir(), "computer-prelaunch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await fs.chmod(dir, 0o700);
  const artifact = join(dir, "artifact.cjs");
  await fs.writeFile(artifact, "/* fixture */", { mode: 0o600 });
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(host.config.dockerSocket, resolve));
  cleanups.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  const identity = await processIdentity(process.pid);
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const namespaces = {
    pid: await fs.readlink("/proc/self/ns/pid"),
    mnt: await fs.readlink("/proc/self/ns/mnt"),
    user: await fs.readlink("/proc/self/ns/user")
  };
  const uidMap = join(dir, "uid-map");
  await fs.writeFile(uidMap, "0 0 4294967295\n");
  const fdinfo = join(dir, "fdinfo-3");
  await fs.writeFile(fdinfo, "pos:\t0\nflags:\t01\n");
  const args = process.execArgv;
  process.execArgv = [];
  cleanups.push(async () => {
    process.execArgv = args;
  });
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ])
    vi.stubEnv(key, undefined);
  const untrusted = new Set<string>();
  const links = new Map<string, string>([
    ["/proc/self/fd/0", "/dev/null"],
    ["/proc/self/fd/1", "/dev/null"],
    ["/proc/self/fd/2", "/dev/null"],
    ["/proc/self/fd/3", "pipe:[77]"],
    [`/proc/${process.pid}/fd/1`, "/dev/null"],
    [`/proc/${process.pid}/fd/2`, "/dev/null"]
  ]);
  const files = new Map<string, string>([
    ["/proc/self/fdinfo/3", fdinfo],
    ["/proc/self/uid_map", uidMap],
    ["/proc/1/uid_map", uidMap]
  ]);
  const originalLstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation((async (...a: Parameters<typeof fs.lstat>) => {
    const stat = await originalLstat(...a);
    const big = typeof stat.uid === "bigint";
    // Root pinning reads with bigint, trust checks do not, so only trust checks see the change.
    const trusted = big || !untrusted.has(String(a[0]));
    return Object.assign(stat, {
      uid: big ? (trusted ? 0n : 1000n) : trusted ? 0 : 1000,
      mode: big ? (stat.mode as bigint) & ~0o022n : (stat.mode as number) & ~0o022
    });
  }) as typeof fs.lstat);
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...a: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(files.get(String(a[0])) ?? a[0], a[1], a[2]);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (...s: Parameters<typeof handle.stat>) =>
      Object.assign(await stat(...s), { uid: 0 })
    );
    return handle;
  });
  const originalLink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation((async (path: string, ...rest: never[]) => {
    const forced = links.get(String(path));
    if (forced !== undefined) return forced;
    if (String(path).startsWith("/proc/1/ns/"))
      return namespaces[String(path).split("/").at(-1) as "pid" | "mnt" | "user"];
    return originalLink(path, ...rest);
  }) as typeof fs.readlink);
  const root = async (name: string) => {
    const path = join(dir, name);
    await fs.mkdir(path, { mode: 0o700 });
    const { dev, ino, uid, gid, mode } = await fs.lstat(path);
    return { path, dev, ino, uid, gid, mode };
  };
  const common = {
    runId: "10000000-0000-4000-8000-000000000001",
    bootId,
    host: host.config,
    data: await root("data"),
    dockerData: await root("docker"),
    monitor: await root("monitor"),
    readyUrl: "http://127.0.0.1:5180/health/ready",
    artifactSha256: sha256(Buffer.from("/* fixture */")),
    namespaces
  };
  const roots = await inspectRoots(host.config);
  await fs.writeFile(
    join(host.config.stateDir, "identity.json"),
    JSON.stringify({ config: host.config, roots }),
    { mode: 0o600 }
  );
  const configPath = join(dir, "config.json");
  const write = (value: Json) => fs.writeFile(configPath, JSON.stringify(value), { mode: 0o600 });
  const supervisor = { ...common, runner: identity };
  const prelaunch = { ...common, kind: "prelaunch" };
  await write(prelaunch);
  return {
    dir,
    artifact,
    configPath,
    supervisor,
    prelaunch,
    socketPath: host.config.dockerSocket,
    controlDir: host.config.controlDir,
    stateDir: host.config.stateDir,
    runnerPid: process.pid,
    untrusted,
    links,
    files,
    write
  };
}

const loaders = {
  supervisor: (f: Fixture) => loadSupervisorDeployment(f.configPath, f.artifact, true),
  prelaunch: (f: Fixture) => loadPrelaunchDeployment(f.configPath, f.artifact, "prelaunch")
} as const;
type Kind = keyof typeof loaders;
const configFor = (f: Fixture, kind: Kind) => (kind === "supervisor" ? f.supervisor : f.prelaunch);

const newRoot = async (path: string) => {
  await fs.mkdir(path, { mode: 0o700 });
  const { dev, ino, uid, gid, mode } = await fs.lstat(path);
  return { path, dev, ino, uid, gid, mode };
};

/** Each mutation breaks exactly one check that both loaders share. */
const sharedChecks: readonly [string, (f: Fixture, kind: Kind) => Promise<void>][] = [
  [
    "bad artifact hash",
    async (f, k) => f.write({ ...configFor(f, k), artifactSha256: "b".repeat(64) })
  ],
  [
    "wrong boot id",
    async (f, k) => f.write({ ...configFor(f, k), bootId: "50000000-0000-4000-8000-000000000005" })
  ],
  [
    "wrong namespace",
    async (f, k) => {
      const value = configFor(f, k);
      await f.write({
        ...value,
        namespaces: { ...(value.namespaces as Json), mnt: "mnt:[999999]" }
      });
    }
  ],
  ["untrusted node binary", async (f) => void f.untrusted.add(process.execPath)],
  ["untrusted artifact", async (f) => void f.untrusted.add(f.artifact)],
  ["loose config mode", async (f) => fs.chmod(f.configPath, 0o640)],
  ["loose parent mode", async (f) => fs.chmod(f.dir, 0o750)],
  ["wrong identity marker", async (f) => fs.writeFile(join(f.stateDir, "identity.json"), "{}")],
  [
    "host root mismatch",
    async (f) => {
      const marker = JSON.parse(await fs.readFile(join(f.stateDir, "identity.json"), "utf8")) as {
        roots: { ino: number }[];
      };
      marker.roots[0]!.ino += 1;
      await fs.writeFile(join(f.stateDir, "identity.json"), JSON.stringify(marker));
    }
  ],
  [
    "docker socket not a socket",
    async (f) => {
      await fs.unlink(f.socketPath);
      await fs.writeFile(f.socketPath, "", { mode: 0o600 });
    }
  ],
  ["docker socket not root owned", async (f) => void f.untrusted.add(f.socketPath)],
  [
    "untrusted data root",
    async (f) => void f.untrusted.add((f.prelaunch.data as { path: string }).path)
  ],
  [
    "untrusted docker data root",
    async (f) => void f.untrusted.add((f.prelaunch.dockerData as { path: string }).path)
  ],
  [
    "untrusted monitor root",
    async (f) => void f.untrusted.add((f.prelaunch.monitor as { path: string }).path)
  ],
  [
    "monitor mode not 0700",
    async (f, k) => {
      const path = (f.prelaunch.monitor as { path: string }).path;
      await fs.chmod(path, 0o750);
      const { dev, ino, uid, gid, mode } = await fs.lstat(path);
      await f.write({ ...configFor(f, k), monitor: { path, dev, ino, uid, gid, mode } });
    }
  ],
  [
    "monitor inside a host root",
    async (f, k) =>
      f.write({ ...configFor(f, k), monitor: await newRoot(join(f.controlDir, "child")) })
  ],
  [
    "monitor equal to a host root",
    async (f, k) => {
      const [control] = (
        await inspectRoots((configFor(f, k) as { host: Parameters<typeof inspectRoots>[0] }).host)
      ).filter((r) => r.path === f.controlDir);
      await f.write({ ...configFor(f, k), monitor: control });
    }
  ]
];

describe("prelaunch configuration parser", () => {
  it("accepts the exact prelaunch shape and nothing from the supervisor shape", async () => {
    const f = await fixture();
    const parsed = parsePrelaunchConfiguration(f.prelaunch);
    expect(parsed.kind).toBe("prelaunch");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parsePrelaunchConfiguration(f.supervisor)).toThrow();
    expect(() =>
      parsePrelaunchConfiguration({ ...f.prelaunch, runner: f.supervisor.runner })
    ).toThrow();
    expect(() => parsePrelaunchConfiguration({ ...f.prelaunch, kind: "supervisor" })).toThrow();
    expect(() => parsePrelaunchConfiguration({ ...f.prelaunch, kind: undefined })).toThrow();
  });
  it("refuses lifetime and capture keys", async () => {
    const f = await fixture();
    expect(() => parsePrelaunchConfiguration({ ...f.prelaunch, lifetime: {} })).toThrow();
    expect(() =>
      parsePrelaunchConfiguration({ ...f.prelaunch, capture: f.prelaunch.data })
    ).toThrow();
  });
  it("makes the supervisor parser refuse a kind key", async () => {
    const f = await fixture();
    expect(() => parseSupervisorConfiguration(f.supervisor)).not.toThrow();
    expect(() => parseSupervisorConfiguration({ ...f.supervisor, kind: "prelaunch" })).toThrow();
    expect(() => parseSupervisorConfiguration(f.prelaunch)).toThrow();
  });
  it("types a prelaunch deployment as unusable where a supervisor deployment is required", () => {
    const acceptsSupervisor = (_deployment: SupervisorDeployment) => undefined;
    const neverRuns = (prelaunch: PrelaunchDeployment) => {
      // @ts-expect-error a prelaunch deployment carries no runner
      acceptsSupervisor(prelaunch);
    };
    expect(neverRuns).toBeTypeOf("function");
  });
});

describe("shared checks refuse through both loaders", () => {
  it.each(["supervisor", "prelaunch"] as const)("%s loader accepts the baseline", async (kind) => {
    const f = await fixture();
    if (kind === "supervisor") await f.write(f.supervisor);
    await expect(loaders[kind](f)).resolves.toBeDefined();
  });
  for (const [name, mutate] of sharedChecks)
    for (const kind of ["supervisor", "prelaunch"] as const)
      it(`${kind} loader refuses ${name}`, async () => {
        const f = await fixture();
        if (kind === "supervisor") await f.write(f.supervisor);
        await mutate(f, kind);
        await expect(loaders[kind](f)).rejects.toThrow("Computer supervisor unavailable");
      });
  it("the supervisor loader keeps its runner check and the prelaunch loader has none", async () => {
    const f = await fixture();
    await f.write({
      ...f.supervisor,
      runner: { ...(f.supervisor.runner as Json), startTicks: "1" }
    });
    await expect(loaders.supervisor(f)).rejects.toThrow();
    await f.write(f.prelaunch);
    await expect(loaders.prelaunch(f)).resolves.toBeDefined();
  });
  it("refuses the other loader's configuration kind", async () => {
    const f = await fixture();
    await expect(loaders.supervisor(f)).rejects.toThrow();
    await f.write(f.supervisor);
    await expect(loaders.prelaunch(f)).rejects.toThrow();
  });
});

describe("hold descriptors", () => {
  const hold = (f: Fixture) => loadPrelaunchDeployment(f.configPath, f.artifact, "hold");
  it("accepts null stdio and a pipe write end on descriptor 3", async () => {
    await expect(hold(await fixture())).resolves.toBeDefined();
  });
  it.each([0, 1, 2])("refuses when descriptor %i is not /dev/null", async (fd) => {
    const f = await fixture();
    f.links.set(`/proc/self/fd/${fd}`, "/dev/pts/0");
    await expect(hold(f)).rejects.toThrow();
  });
  it("refuses a descriptor 3 that is not a pipe", async () => {
    const f = await fixture();
    f.links.set("/proc/self/fd/3", "/tmp/file");
    await expect(hold(f)).rejects.toThrow();
  });
  it("refuses a descriptor 3 that is a read end", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.dir, "fdinfo-3"), "flags:\t00\n");
    await expect(hold(f)).rejects.toThrow();
  });
  it("does not ask the prelaunch sampler mode for those descriptors", async () => {
    const f = await fixture();
    f.links.set("/proc/self/fd/0", "pipe:[1]");
    f.links.delete("/proc/self/fd/3");
    await expect(loaders.prelaunch(f)).resolves.toBeDefined();
  });
  it("never runs the heartbeat check, which the supervisor loader still runs", async () => {
    const f = await fixture();
    const opendir = vi.spyOn(fs, "opendir");
    await hold(f);
    expect(opendir).not.toHaveBeenCalled();
    await f.write(f.supervisor);
    f.links.set("/proc/self/fd/0", "pipe:[5]");
    await fs.writeFile(join(f.dir, "fdinfo-0"), "flags:\t00\n");
    f.files.set("/proc/self/fdinfo/0", join(f.dir, "fdinfo-0"));
    await loadSupervisorDeployment(f.configPath, f.artifact, false).catch(() => undefined);
    expect(opendir).toHaveBeenCalled();
  });
});

describe("mode and kind matrix against real files", () => {
  const deps = (): WatchdogDeps => ({
    now: () => 0,
    sleep: async () => undefined,
    exit: () => undefined,
    setTimer: () => 0,
    clearTimer: () => undefined,
    selfPid: () => process.pid,
    parentPid: () => process.ppid,
    writeAck: async () => undefined
  });
  const argv = (f: Fixture, mode: string) => ["node", f.artifact, mode, f.configPath];
  it("refuses hold and prelaunch with a runner configuration", async () => {
    const f = await fixture();
    await f.write(f.supervisor);
    await expect(loaders.supervisor(f), "file is a valid runner config").resolves.toBeDefined();
    expect(await runWatchdog(argv(f, "hold"), deps())).toBe(2);
    expect(await runWatchdog(argv(f, "prelaunch"), deps())).toBe(2);
  });
  it.each(["observe", "fence", "manage", "collect"])(
    "refuses %s with a prelaunch configuration",
    async (mode) => {
      const f = await fixture();
      await expect(loaders.prelaunch(f), "file is a valid prelaunch config").resolves.toBeDefined();
      expect(await runWatchdog(argv(f, mode), deps())).toBe(2);
    }
  );
});
