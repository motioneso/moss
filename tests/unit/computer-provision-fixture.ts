import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { vi } from "vitest";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";
import { resourceName, resourceSpec } from "../../scripts/computer-host/spec.js";
import { loadProvisionDeployment } from "../../scripts/computer-provision/config.js";
import { provisionCreatedComputerRun } from "../../scripts/computer-provision/run.js";
import { isolatedConfig } from "./computer-host-fixture.js";
import type { RootIdentity } from "../../scripts/computer-host/config.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
vi.mock("../../scripts/computer-watchdog/trust.js", async (original) => ({
  ...(await original<typeof trust>())
}));

/** Actual Unix Docker protocol/files/runner; disclosed root/runtime/namespace/Node trust projection. */
export async function provisionFixture(
  registerCleanup: (close: () => Promise<void>) => void,
  nativeGatewayGid?: number
) {
  const nativeUid = process.getuid!();
  const nativeGid = process.getgid!();
  const host = await isolatedConfig();
  const root = dirname(host.config.stateDir);
  const handles: fs.FileHandle[] = [];
  const owned: { node?: ReturnType<typeof spawn>; docker?: ReturnType<typeof createServer> } = {};
  const execArgv = process.execArgv;
  const close = async () => {
    process.execArgv = execArgv;
    vi.unstubAllEnvs();
    const stopped = await Promise.allSettled([
      ...handles.map(async (file) => file.close()),
      (async () => {
        const node = owned.node;
        if (node?.pid && node.exitCode === null && node.signalCode === null) {
          const exited = once(node, "exit");
          node.kill("SIGKILL");
          await exited;
        }
      })(),
      (async () => {
        const docker = owned.docker;
        if (docker?.listening) {
          docker.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            docker!.close((error) => (error ? reject(error) : resolve()))
          );
        }
      })()
    ]);
    const removed = await Promise.allSettled([host.close()]);
    const failures = [...stopped, ...removed].filter((r) => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures, "Provision fixture cleanup failed");
  };
  registerCleanup(close);
  for (const name of ["output", "input", "data", "docker-data", "monitor"])
    await fs.mkdir(join(root, name), { mode: 0o700 });
  await fs.chmod(host.config.gatewayConfigDir, 0o750);
  if (nativeGatewayGid !== undefined)
    await fs.chown(host.config.gatewayConfigDir, nativeUid, nativeGatewayGid);
  const node = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    detached: true
  });
  owned.node = node;
  await once(node, "spawn");
  const runner = await trust.processIdentity(node.pid!);
  const project = <T extends { uid: number | bigint; gid: number | bigint; mode: number | bigint }>(
    stat: T
  ): T =>
    Object.assign(stat, {
      uid: typeof stat.uid === "bigint" ? 0n : 0,
      gid: typeof stat.gid === "bigint" ? 1000n : 1000,
      mode: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022
    });
  const originalStat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) =>
    project(await originalStat(...args))
  );
  const uidMap = join(root, "input/uid-map");
  await fs.writeFile(uidMap, "0 0 4294967295\n");
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(
      String(args[0]).endsWith("/uid_map") ? uidMap : args[0],
      args[1],
      args[2]
    );
    handles.push(file);
    const stat = file.stat.bind(file);
    vi.spyOn(file, "stat").mockImplementation(async (...statArgs: Parameters<typeof file.stat>) =>
      project(await stat(...statArgs))
    );
    const chown = file.chown.bind(file);
    vi.spyOn(file, "chown").mockImplementation((uid, gid) =>
      chown(uid === 0 ? nativeUid : uid, gid === 1000 ? nativeGid : gid)
    );
    return file;
  });
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  process.execArgv = [];
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
  const namespaces = {
    pid: await fs.readlink("/proc/self/ns/pid"),
    mnt: await fs.readlink("/proc/self/ns/mnt"),
    user: await fs.readlink("/proc/self/ns/user")
  };
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const originalLink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation(async (path, ...args) => {
    if (String(path).startsWith("/proc/1/ns/"))
      return namespaces[String(path).split("/").at(-1) as "pid" | "mnt" | "user"];
    return originalLink(path, ...args);
  });
  const read = trust.boundedFile;
  vi.spyOn(trust, "boundedFile").mockImplementation((path, limit) =>
    path === process.execPath
      ? Promise.resolve(Buffer.from("disclosed native Node hash fixture"))
      : read(path, limit)
  );
  const resources = [
    { role: "gateway" as const, generation: 1, id: "a".repeat(64) },
    { role: "desktop" as const, generation: 1, id: "b".repeat(64) }
  ];
  const defaults = {
    Cmd: ["fixed-entrypoint"],
    Entrypoint: null,
    Env: [],
    WorkingDir: "",
    Healthcheck: null
  };
  const containers = resources.map((resource) => {
    const spec = resourceSpec(host.config, resource);
    return {
      Id: resource.id,
      Name: `/${resourceName(host.config, resource)}`,
      Image: spec.Image,
      Config: { ...defaults, ...spec },
      HostConfig: spec.HostConfig,
      State: { Running: false, Status: "created", Pid: 0, StartedAt: "0001-01-01T00:00:00Z" },
      NetworkSettings: { Ports: {} },
      Mounts: spec.HostConfig.Binds.map((bind) => {
        const [Source, Destination, mode] = bind.split(":");
        return { Type: "bind", Source, Destination, RW: mode === "rw", Propagation: "rprivate" };
      })
    };
  });
  const calls: { method: string; path: string }[] = [];
  const docker = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    calls.push({ method: request.method!, path: url.pathname });
    const send = (status: number, body: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.method !== "GET") {
      send(500, {});
      return;
    }
    if (url.pathname.includes("/images/")) {
      send(200, {
        Id: decodeURIComponent(url.pathname.split("/images/")[1]!.slice(0, -5)),
        Config: defaults
      });
      return;
    }
    if (url.pathname === "/v1.47/containers/json") {
      send(
        200,
        containers.map((c) => ({ Id: c.Id }))
      );
      return;
    }
    const item = containers.find((c) => url.pathname === `/v1.47/containers/${c.Id}/json`);
    send(item ? 200 : 404, item ?? {});
  });
  owned.docker = docker;
  await new Promise<void>((resolve) => docker.listen(host.config.dockerSocket, resolve));
  const store = await HostStateStore.open(host.config);
  await store.save({ generation: 1, enabled: true, resources });
  await store.close();
  const rootIdentity = async (path: string): Promise<RootIdentity> => {
    const { dev, ino, uid, gid, mode } = await fs.lstat(path);
    return { path, dev, ino, uid, gid, mode };
  };
  const artifact = join(root, "input/provision.cjs");
  const supervisorArtifact = join(root, "input/watchdog.cjs");
  await fs.writeFile(artifact, "/* provision artifact fixture */", { mode: 0o600 });
  await fs.writeFile(supervisorArtifact, "/* watchdog artifact fixture */", { mode: 0o600 });
  const configuration = {
    artifactSha256: trust.sha256(await fs.readFile(artifact)),
    supervisor: {
      runId: "50000000-0000-4000-8000-000000000005",
      runner,
      host: host.config,
      data: await rootIdentity(join(root, "data")),
      dockerData: await rootIdentity(join(root, "docker-data")),
      monitor: await rootIdentity(join(root, "monitor")),
      readyUrl: "http://127.0.0.1:5180/health/ready",
      artifactSha256: trust.sha256(await fs.readFile(supervisorArtifact)),
      bootId,
      namespaces
    },
    output: await rootIdentity(join(root, "output")),
    supervisorArtifactPath: supervisorArtifact
  };
  const path = join(root, "input/provision.json");
  const save = () => fs.writeFile(path, JSON.stringify(configuration), { mode: 0o600 });
  await save();
  let now = 0;
  let interrupted = false;
  const deployment = await loadProvisionDeployment(path, artifact);
  return {
    nativeUid,
    nativeGid,
    nativeStat: originalStat,
    io: fs,
    root,
    host: host.config,
    resources,
    containers,
    calls,
    configuration,
    path,
    artifact,
    save,
    deployment,
    setNow: (value: number) => {
      now = value;
    },
    interrupt: () => {
      interrupted = true;
    },
    run: () =>
      provisionCreatedComputerRun(deployment, {
        startedAtMs: 0,
        now: () => now,
        interrupted: () => interrupted
      }),
    close
  };
}
