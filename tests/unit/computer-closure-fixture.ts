import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostFixture } from "./computer-host-fixture.js";
import { inspectRoots, type RootIdentity } from "../../scripts/computer-host/config.js";
import { closureFile, recheckClosureFile } from "../../scripts/computer-closure/files.js";
import type {
  ClosureConfiguration,
  ClosureDeployment
} from "../../scripts/computer-closure/config.js";
import { assertRoot } from "../../scripts/computer-watchdog/linux-files.js";
import { computerMonotonicMs } from "../../scripts/computer-watchdog/linux.js";
import type { WatchdogProcessIdentity } from "../../scripts/computer-watchdog/policy.js";
import { processIdentity, sha256 } from "../../scripts/computer-watchdog/trust.js";

export async function deadClosureProcess(): Promise<WatchdogProcessIdentity> {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  try {
    await once(child, "message");
    return await processIdentity(child.pid!);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

/** Synthetic trusted deployment, Unix HTTP Docker/readiness; real files, signing and OS probes. */
export async function closureFixture(identities: readonly WatchdogProcessIdentity[]) {
  const host = await hostFixture();
  await host.releaseControl();
  const root = await mkdtemp(join(tmpdir(), "closure-"));
  await chmod(root, 0o700);
  const pinned = async (name: string): Promise<RootIdentity> => {
    const path = join(root, name);
    await mkdir(path, { mode: 0o700 });
    const { dev, ino, uid, gid, mode } = await lstat(path);
    return { path, dev, ino, uid, gid, mode };
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const signingKeyPath = join(root, "key.pem");
  await writeFile(signingKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600
  });
  const [runner, watchdog, desktop, gateway, collector] = identities;
  const runId = "50000000-0000-4000-8000-000000000005";
  const binding = {
    runId,
    instanceId: host.config.instanceId,
    requestGeneration: 1,
    desktopId: "d".repeat(64),
    desktopGeneration: 1,
    gatewayId: "e".repeat(64),
    gatewayGeneration: 1
  };
  const configuration: ClosureConfiguration = {
    supervisor: {
      runId,
      runner: runner!,
      host: host.config,
      lifetime: { binding, secret: "a".repeat(64) },
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      namespaces: {
        pid: await readlink("/proc/self/ns/pid"),
        mnt: await readlink("/proc/self/ns/mnt"),
        user: await readlink("/proc/self/ns/user")
      },
      data: await pinned("data"),
      dockerData: await pinned("docker"),
      monitor: await pinned("monitor"),
      readyUrl: "http://127.0.0.1:5180/health/ready",
      artifactSha256: "f".repeat(64)
    },
    processes: { watchdog: watchdog!, desktop: desktop!, gateway: gateway! },
    artifactSha256: "b".repeat(64),
    netNamespace: await readlink("/proc/self/ns/net"),
    receipt: await pinned("receipt"),
    signingKeyPath,
    publicKeySha256: sha256(createPublicKey(privateKey).export({ type: "spki", format: "der" }))
  };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  const roots = await inspectRoots(host.config);
  const state = {
    enabled: false,
    generation: 2,
    resources: [
      { role: "desktop", generation: 1, id: binding.desktopId },
      { role: "gateway", generation: 1, id: binding.gatewayId }
    ]
  };
  await writeFile(
    join(host.config.stateDir, "identity.json"),
    JSON.stringify({ config: host.config, roots }),
    { mode: 0o600 }
  );
  const statePath = join(host.config.stateDir, "state.json");
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  const stopPath = join(host.config.stateDir, "stop.json");
  await writeFile(
    stopPath,
    JSON.stringify({
      schemaVersion: 1,
      reason: "operator-stop",
      instanceId: host.config.instanceId,
      roots,
      state: { ...state, enabled: true, generation: 1 }
    }),
    { mode: 0o600 }
  );
  const journalPath = join(configuration.supervisor.monitor.path, "observation.jsonl");
  const records = [
    { type: "start", configuration: { runId, runner, watchdog, startedAtMs: 1 } },
    { type: "collector", identity: collector },
    { type: "stop", atMs: 2, reason: "operator-stop", collector, collectorPid: collector!.pid }
  ];
  await writeFile(journalPath, records.map((r) => JSON.stringify(r) + "\n").join(""), {
    mode: 0o600
  });
  const deployment: ClosureDeployment = {
    configuration,
    config: await closureFile(configPath, 16384),
    keyFile: await closureFile(signingKeyPath, 4096),
    signingKey: createPrivateKey(await readFile(signingKeyPath)),
    artifactPath: join(root, "fixture.cjs"),
    nodePath: process.execPath,
    anchors: {
      artifact: "disclosed fixture",
      node: "disclosed fixture",
      dockerSocket: "disclosed fixture"
    },
    roots
  };
  const readySocket = join(root, "ready.sock");
  let healthy = true;
  const readyServer = createServer((_request, response) => {
    response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: healthy, db: "ok", pgboss: "ok" }));
  });
  await new Promise<void>((resolve) => readyServer.listen(readySocket, resolve));
  return {
    host,
    root,
    deployment,
    statePath,
    stopPath,
    journalPath,
    records,
    readySocket,
    unhealthy() {
      healthy = false;
    },
    async close() {
      await new Promise<void>((resolve) => readyServer.close(() => resolve()));
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

export async function fixtureRevalidate(deployment: ClosureDeployment): Promise<void> {
  await recheckClosureFile(deployment.config);
  await recheckClosureFile(deployment.keyFile);
  for (const root of [
    ...deployment.roots,
    deployment.configuration.receipt,
    deployment.configuration.supervisor.monitor
  ])
    await assertRoot(root);
}
export const closureStarted = computerMonotonicMs;
