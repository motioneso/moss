import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, sep } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import { inspectRoots, type RootIdentity } from "../computer-host/config.js";
import { assertRoot, snapshotRoot } from "../computer-watchdog/linux-files.js";
import { snapshotProcess } from "../computer-watchdog/linux.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";
import {
  assertNamespaceAnchors,
  assertSupervisorRuntime,
  assertTrustedPath,
  boundedFile,
  parseSupervisorConfiguration,
  sha256,
  supervisorError,
  type SupervisorConfiguration
} from "../computer-watchdog/trust.js";
import { closureFile, recheckClosureFile, type ClosureFile } from "./files.js";

export interface ClosureConfiguration {
  readonly supervisor: SupervisorConfiguration;
  readonly artifactSha256: string;
  readonly processes: Readonly<Record<"watchdog" | "desktop" | "gateway", WatchdogProcessIdentity>>;
  readonly netNamespace: string;
  readonly receipt: RootIdentity;
  readonly signingKeyPath: string;
  readonly publicKeySha256: string;
}
export interface ClosureDeployment {
  readonly configuration: ClosureConfiguration;
  readonly config: ClosureFile;
  readonly keyFile: ClosureFile;
  readonly signingKey: KeyObject;
  readonly artifactPath: string;
  readonly nodePath: string;
  readonly roots: readonly RootIdentity[];
  readonly anchors: Readonly<Record<"artifact" | "node" | "dockerSocket", string>>;
}
export async function closureMetadata(path: string): Promise<string> {
  const { dev, ino, uid, gid, mode, size, mtimeMs, ctimeMs } = await lstat(path);
  return JSON.stringify({ dev, ino, uid, gid, mode, size, mtimeMs, ctimeMs });
}
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const overlaps = (a: string, b: string): boolean => {
  const r = relative(a, b);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};
export function parseClosureConfiguration(value: unknown): ClosureConfiguration {
  if (
    !gatewayFields(
      value,
      "artifactSha256,netNamespace,processes,publicKeySha256,receipt,signingKeyPath,supervisor"
    ) ||
    !gatewayFields(value.processes, "desktop,gateway,watchdog") ||
    !gatewayFields(value.receipt, "dev,gid,ino,mode,path,uid") ||
    !hash(value.artifactSha256) ||
    !hash(value.publicKeySha256) ||
    typeof value.netNamespace !== "string" ||
    !/^net:\[[0-9]+\]$/.test(value.netNamespace) ||
    typeof value.signingKeyPath !== "string" ||
    !isAbsolute(value.signingKeyPath) ||
    normalize(value.signingKeyPath) !== value.signingKeyPath
  )
    throw supervisorError();
  const supervisor = parseSupervisorConfiguration(value.supervisor);
  if (!supervisor.lifetime) throw supervisorError();
  const identity = (item: unknown): WatchdogProcessIdentity => {
    if (!gatewayFields(item, "pid,processGroupId,startTicks")) throw supervisorError();
    return snapshotProcess(item as unknown as WatchdogProcessIdentity);
  };
  const processes = Object.freeze({
    watchdog: identity(value.processes.watchdog),
    desktop: identity(value.processes.desktop),
    gateway: identity(value.processes.gateway)
  });
  if (
    new Set([supervisor.runner.pid, ...Object.values(processes).map((p) => p.pid)]).size !== 4 ||
    supervisor.runner.processGroupId === processes.watchdog.processGroupId
  )
    throw supervisorError();
  const receipt = snapshotRoot(value.receipt as unknown as RootIdentity);
  if (receipt.uid !== 0 || (receipt.mode & 0o7777) !== 0o700) throw supervisorError();
  return Object.freeze({
    supervisor,
    artifactSha256: value.artifactSha256,
    processes,
    netNamespace: value.netNamespace,
    receipt,
    signingKeyPath: value.signingKeyPath,
    publicKeySha256: value.publicKeySha256
  });
}

/** Post-stop loader: deliberately does not call the live-run supervisor/heartbeat loader. */
export async function loadClosureDeployment(
  configPath: string,
  artifactPath: string
): Promise<ClosureDeployment> {
  assertSupervisorRuntime(true);
  await assertTrustedPath(configPath, false);
  if (((await lstat(dirname(configPath))).mode & 0o7777) !== 0o700) throw supervisorError();
  const config = await closureFile(configPath, 16384);
  const configuration = parseClosureConfiguration(JSON.parse(config.bytes.toString("utf8")));
  const nodePath = process.execPath;
  for (const path of [nodePath, artifactPath, configuration.signingKeyPath])
    await assertTrustedPath(path, false);
  if (sha256(await boundedFile(artifactPath, 2 * 1024 ** 2)) !== configuration.artifactSha256)
    throw supervisorError();
  await assertNamespaceAnchors(configuration.supervisor);
  for (const pid of ["self", "1"])
    if ((await readlink(`/proc/${pid}/ns/net`)) !== configuration.netNamespace)
      throw supervisorError();
  const roots = await inspectRoots(configuration.supervisor.host);
  for (const root of [
    configuration.supervisor.data,
    configuration.supervisor.dockerData,
    configuration.supervisor.monitor,
    configuration.receipt
  ]) {
    await assertRoot(root);
    await assertTrustedPath(root.path, true);
  }
  const all = [
    ...roots,
    configuration.supervisor.monitor,
    configuration.supervisor.data,
    configuration.supervisor.dockerData
  ];
  if ((configuration.supervisor.monitor.mode & 0o7777) !== 0o700) throw supervisorError();
  for (const ancestor of all)
    for (const child of all) {
      if (ancestor === child || !overlaps(ancestor.path, child.path)) continue;
      if (
        ancestor.path === child.path ||
        ![configuration.supervisor.data, configuration.supervisor.dockerData].includes(ancestor)
      )
        throw supervisorError();
    }
  if (
    all.some(
      (root) =>
        overlaps(root.path, configuration.receipt.path) ||
        overlaps(configuration.receipt.path, root.path)
    )
  )
    throw supervisorError();
  // No mounted directory may expose the private signing key or trusted closure input.
  if (
    all.some((root) =>
      [configPath, configuration.signingKeyPath, artifactPath].some((path) =>
        overlaps(root.path, path)
      )
    )
  )
    throw supervisorError();
  const socketPath = configuration.supervisor.host.dockerSocket;
  await assertTrustedPath(dirname(socketPath), true);
  const socket = await lstat(socketPath);
  if (
    !socket.isSocket() ||
    socket.uid !== 0 ||
    socket.nlink !== 1 ||
    (socket.mode & 0o002) !== 0 ||
    (await realpath(socketPath)) !== socketPath
  )
    throw supervisorError();
  const keyFile = await closureFile(configuration.signingKeyPath, 4096);
  const signingKey = createPrivateKey({ key: keyFile.bytes, format: "pem", type: "pkcs8" });
  if (
    signingKey.asymmetricKeyType !== "ed25519" ||
    sha256(createPublicKey(signingKey).export({ format: "der", type: "spki" })) !==
      configuration.publicKeySha256
  )
    throw supervisorError();
  return Object.freeze({
    configuration,
    config,
    keyFile,
    signingKey,
    artifactPath,
    nodePath,
    anchors: Object.freeze({
      artifact: await closureMetadata(artifactPath),
      node: await closureMetadata(nodePath),
      dockerSocket: await closureMetadata(socketPath)
    }),
    roots: Object.freeze(roots)
  });
}

export async function revalidateClosureDeployment(deployment: ClosureDeployment): Promise<void> {
  await recheckClosureFile(deployment.config);
  await recheckClosureFile(deployment.keyFile);
  const current = await loadClosureDeployment(deployment.config.path, deployment.artifactPath);
  if (
    current.config.dev !== deployment.config.dev ||
    current.config.ino !== deployment.config.ino ||
    current.keyFile.dev !== deployment.keyFile.dev ||
    current.keyFile.ino !== deployment.keyFile.ino ||
    current.config.hash !== deployment.config.hash ||
    current.keyFile.hash !== deployment.keyFile.hash ||
    JSON.stringify(current.roots) !== JSON.stringify(deployment.roots) ||
    current.nodePath !== deployment.nodePath ||
    JSON.stringify(current.anchors) !== JSON.stringify(deployment.anchors)
  )
    throw supervisorError();
}
