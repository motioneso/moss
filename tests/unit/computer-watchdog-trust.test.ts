import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertNamespaceAnchors,
  assertSupervisorRuntime,
  assertTrustedPath,
  boundedFile,
  loadSupervisorDeployment,
  parseSupervisorConfiguration,
  processIdentity
} from "../../scripts/computer-watchdog/trust.js";
import { DIRECTORY_KEYS, inspectRoots } from "../../scripts/computer-host/config.js";
import { isolatedConfig } from "./computer-host-fixture.js";
import { createServer } from "node:net";
import { sha256, revalidateDeployment } from "../../scripts/computer-watchdog/trust.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});
function config() {
  const root = (path: string) => ({ path, dev: 1, ino: 2, uid: 0, gid: 0, mode: 0o40700 });
  return {
    runId: "10000000-0000-4000-8000-000000000001",
    bootId: "20000000-0000-4000-8000-000000000002",
    runner: { pid: 101, processGroupId: 101, startTicks: "123" },
    host: {
      ...Object.fromEntries(DIRECTORY_KEYS.map((key) => [key, `/trusted/${key}`])),
      instanceId: "30000000-0000-4000-8000-000000000003",
      ownerUserId: "40000000-0000-4000-8000-000000000004",
      dockerSocket: "/trusted/docker.sock",
      gatewayImage: null
    },
    data: root("/data"),
    dockerData: root("/docker-data"),
    monitor: root("/monitor"),
    readyUrl: "http://127.0.0.1:5180/health/ready",
    artifactSha256: "a".repeat(64),
    namespaces: { pid: "pid:[1]", mnt: "mnt:[2]", user: "user:[3]" }
  };
}
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "computer-trust-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
describe("root supervisor trust checks, no installed deployment claim", () => {
  it("revalidates actual config/artifact bytes with disclosed root ownership, namespace and output fixtures", async () => {
    const host = await isolatedConfig();
    cleanups.push(() => host.close());
    const path = await temporary();
    await fs.chmod(path, 0o700);
    const artifact = join(path, "artifact.cjs");
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
    const uidMap = join(path, "uid-map");
    await fs.writeFile(uidMap, "0 0 4294967295\n");
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
    const originalStat = fs.lstat;
    const rootMetadata = <T extends { uid: number | bigint; mode: number | bigint }>(stat: T): T =>
      Object.assign(stat, {
        uid: typeof stat.uid === "bigint" ? 0n : 0,
        mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
      });
    vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) =>
      rootMetadata(await originalStat(...args))
    );
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(
        String(args[0]).endsWith("/uid_map") ? uidMap : args[0],
        args[1],
        args[2]
      );
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (...args: Parameters<typeof handle.stat>) =>
        rootMetadata(await stat(...args))
      );
      return handle;
    });
    const originalLink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (path, ...args) => {
      if ([`/proc/${process.pid}/fd/1`, `/proc/${process.pid}/fd/2`].includes(String(path)))
        return "/dev/null";
      if (String(path).startsWith("/proc/1/ns/"))
        return namespaces[String(path).split("/").at(-1) as "pid" | "mnt" | "user"];
      return originalLink(path, ...args);
    });
    const root = async (name: string) => {
      const rootPath = join(path, name);
      await fs.mkdir(rootPath, { mode: 0o700 });
      const { dev, ino, uid, gid, mode } = await fs.lstat(rootPath);
      return { path: rootPath, dev, ino, uid, gid, mode };
    };
    const value = {
      ...config(),
      host: host.config,
      runner: identity,
      bootId,
      namespaces,
      artifactSha256: sha256(Buffer.from("/* fixture */")),
      data: await root("data"),
      dockerData: await root("docker"),
      monitor: await root("monitor")
    };
    const roots = await inspectRoots(host.config);
    await fs.writeFile(
      join(host.config.stateDir, "identity.json"),
      JSON.stringify({ config: host.config, roots }),
      { mode: 0o600 }
    );
    const configPath = join(path, "config.json");
    const bytes = JSON.stringify(value);
    await fs.writeFile(configPath, bytes, { mode: 0o600 });
    await expect(
      assertTrustedPath(configPath, false),
      "configuration path"
    ).resolves.toBeUndefined();
    await expect(assertTrustedPath(artifact, false), "artifact path").resolves.toBeUndefined();
    await expect(assertTrustedPath(process.execPath, false), "node path").resolves.toBeUndefined();
    await expect(
      assertNamespaceAnchors(parseSupervisorConfiguration(value)),
      "namespace anchors"
    ).resolves.toBeUndefined();
    const deployment = await loadSupervisorDeployment(configPath, artifact, true);
    await expect(revalidateDeployment(deployment)).resolves.toBeUndefined();
    const controlRoot = roots.find((root) => root.path === host.config.controlDir)!;
    for (const name of ["child", "..monitor"]) {
      const path = join(host.config.controlDir, name);
      await fs.mkdir(path, { mode: 0o700 });
      const { dev, ino, uid, gid, mode } = await fs.lstat(path);
      await fs.writeFile(
        configPath,
        JSON.stringify({ ...value, monitor: { path, dev, ino, uid, gid, mode } })
      );
      await expect(
        loadSupervisorDeployment(configPath, artifact, true),
        `overlapping monitor ${name}`
      ).rejects.toThrow();
    }
    await fs.writeFile(configPath, JSON.stringify({ ...value, monitor: controlRoot }));
    await expect(
      loadSupervisorDeployment(configPath, artifact, true),
      "equal roots"
    ).rejects.toThrow();
    await fs.writeFile(configPath, bytes);
    await fs.appendFile(configPath, "\n");
    await expect(revalidateDeployment(deployment)).rejects.toThrow();
    await fs.writeFile(configPath, bytes);
    await fs.writeFile(artifact, "changed bytes");
    await expect(revalidateDeployment(deployment)).rejects.toThrow();
  });
  it("parses exact independently provisioned anchors and snapshots configuration", () => {
    const value = config();
    const parsed = parseSupervisorConfiguration(value);
    value.runner.startTicks = "999";
    value.namespaces.pid = "pid:[999]";
    expect(parsed.runner.startTicks).toBe("123");
    expect(parsed.namespaces.pid).toBe("pid:[1]");
    expect(() => parseSupervisorConfiguration({ ...config(), logsBounded: true })).toThrow();
    expect(() =>
      parseSupervisorConfiguration({ ...config(), runner: { ...config().runner, extra: true } })
    ).toThrow();
  });
  it.each([
    "http://example.invalid/health/ready",
    "http://localhost/health/ready",
    "http://127.0.0.1/health",
    "http://user:secret@127.0.0.1/health/ready",
    "http://127.0.0.1/health/ready?q=1",
    "http://127.0.0.1/health/ready#x",
    "file:///health/ready"
  ])("rejects unsafe readiness destination %s before network I/O", (readyUrl) => {
    expect(() => parseSupervisorConfiguration({ ...config(), readyUrl })).toThrow();
  });
  it("requires effective/real root and rejects process loaders before filesystem I/O", async () => {
    const spy = vi.spyOn(fs, "open");
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    await expect(loadSupervisorDeployment("/missing", "/missing")).rejects.toThrow(
      "Computer supervisor unavailable"
    );
    expect(spy).not.toHaveBeenCalled();
    vi.spyOn(process, "getuid").mockReturnValue(0);
    vi.spyOn(process, "geteuid").mockReturnValue(0);
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted");
    expect(() => assertSupervisorRuntime(false)).toThrow();
  });
  it("refuses a real writable/sticky ancestor and symlink instead of trusting matching UID", async () => {
    const path = await temporary();
    const file = join(path, "artifact.cjs");
    await writeFile(file, "safe", { mode: 0o600 });
    await expect(assertTrustedPath(file, false)).rejects.toThrow();
    const link = join(path, "link");
    await symlink(file, link);
    await expect(assertTrustedPath(link, false)).rejects.toThrow();
  });
  it("bounds file bytes and rejects final symlinks", async () => {
    const path = await temporary();
    const file = join(path, "bytes");
    await writeFile(file, "12345");
    await expect(boundedFile(file, 4)).rejects.toThrow();
    expect((await boundedFile(file, 5)).toString()).toBe("12345");
    await symlink(file, join(path, "link"));
    await expect(boundedFile(join(path, "link"), 5)).rejects.toThrow();
  });
  it("derives its real proc identity rather than accepting a healthy flag", async () => {
    const identity = await processIdentity(process.pid);
    expect(identity.pid).toBe(process.pid);
    expect(identity.startTicks).toMatch(/^[0-9]+$/);
    await expect(processIdentity(-1)).rejects.toThrow();
  });
  it("compares explicit namespace/boot anchors for both self and PID1 and rejects changed anchors", async () => {
    const value = config();
    value.bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    for (const key of ["pid", "mnt", "user"] as const)
      value.namespaces[key] = await fs.readlink(`/proc/self/ns/${key}`);
    // Host fixture may itself run inside a namespace. Explicitly spoof PID1/map only for this test.
    const originalOpen = fs.open;
    const path = await temporary();
    const map = join(path, "uid_map");
    await writeFile(map, "0 0 4294967295\n");
    vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) =>
      originalOpen(String(args[0]).endsWith("/uid_map") ? map : args[0], args[1], args[2])
    );
    const originalLink = fs.readlink;
    vi.spyOn(fs, "readlink").mockImplementation(async (path, ...args) =>
      String(path).startsWith("/proc/1/ns/")
        ? value.namespaces[String(path).split("/").at(-1) as "pid" | "mnt" | "user"]
        : originalLink(path, ...args)
    );
    await assertNamespaceAnchors(parseSupervisorConfiguration(value));
    await expect(
      assertNamespaceAnchors(
        parseSupervisorConfiguration({
          ...value,
          namespaces: { ...value.namespaces, mnt: "mnt:[999999]" }
        })
      )
    ).rejects.toThrow();
    await expect(
      assertNamespaceAnchors(parseSupervisorConfiguration({ ...value, bootId: config().bootId }))
    ).rejects.toThrow();
    await writeFile(map, "0 1000 1\n");
    await expect(assertNamespaceAnchors(parseSupervisorConfiguration(value))).rejects.toThrow();
  });
});
