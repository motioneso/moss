import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, relative } from "node:path";
import { isRecord, isUuid } from "../../apps/api/src/computer/host-contract.js";
import {
  inspectRoots,
  parseHostConfig,
  type HostConfig,
  type RootIdentity
} from "../computer-host/config.js";
import { privateJson } from "../computer-host/state.js";
import { assertLinuxProc, assertRoot, snapshotRoot } from "./linux-files.js";
import { readComputerProcess } from "./linux.js";
import type { WatchdogProcessIdentity } from "./policy.js";

export const supervisorError = () => new Error("Computer supervisor unavailable");
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export interface SupervisorConfiguration {
  readonly runId: string;
  readonly runner: WatchdogProcessIdentity;
  readonly host: HostConfig;
  readonly data: RootIdentity;
  readonly dockerData: RootIdentity;
  readonly monitor: RootIdentity;
  readonly readyUrl: string;
  readonly artifactSha256: string;
  readonly bootId: string;
  readonly namespaces: Readonly<Record<"pid" | "mnt" | "user", string>>;
}
export interface SupervisorDeployment {
  readonly configuration: SupervisorConfiguration;
  readonly configPath: string;
  readonly configSha256: string;
  readonly artifactPath: string;
  readonly nodePath: string;
  readonly roots: readonly RootIdentity[];
  readonly marker: string;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw supervisorError();
  return value;
}
function pinnedRoot(value: unknown): RootIdentity {
  exact(value, ["path", "dev", "ino", "uid", "gid", "mode"]);
  return snapshotRoot(value as RootIdentity);
}
export function parseSupervisorConfiguration(value: unknown): SupervisorConfiguration {
  const record = exact(value, [
    "runId",
    "runner",
    "host",
    "data",
    "dockerData",
    "monitor",
    "readyUrl",
    "artifactSha256",
    "bootId",
    "namespaces"
  ]);
  const runner = exact(record.runner, ["pid", "startTicks", "processGroupId"]);
  const namespaces = exact(record.namespaces, ["pid", "mnt", "user"]);
  if (
    !isUuid(record.runId) ||
    !isUuid(record.bootId) ||
    ![runner.pid, runner.processGroupId].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0
    ) ||
    typeof runner.startTicks !== "string" ||
    !/^[0-9]{1,20}$/.test(runner.startTicks) ||
    /^0+$/.test(runner.startTicks) ||
    typeof record.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.artifactSha256) ||
    typeof record.readyUrl !== "string" ||
    !Object.entries(namespaces).every(
      ([key, val]) =>
        typeof val === "string" &&
        new RegExp(`^${key === "mnt" ? "mnt" : key}:\\[[0-9]+\\]$`).test(val)
    )
  )
    throw supervisorError();
  const url = new URL(record.readyUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/health/ready" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== record.readyUrl
  )
    throw supervisorError();
  return Object.freeze({
    runId: record.runId,
    bootId: record.bootId,
    runner: Object.freeze({ ...runner }) as unknown as WatchdogProcessIdentity,
    host: parseHostConfig(record.host),
    data: pinnedRoot(record.data),
    dockerData: pinnedRoot(record.dockerData),
    monitor: pinnedRoot(record.monitor),
    readyUrl: url.href,
    artifactSha256: record.artifactSha256,
    namespaces: Object.freeze({ ...namespaces }) as SupervisorConfiguration["namespaces"]
  });
}

/** Strict root ancestry. Sticky writable directories are not trusted deployment locations. */
export async function assertTrustedPath(path: string, directory: boolean): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path || (await realpath(path)) !== path)
    throw supervisorError();
  let current = path;
  for (;;) {
    const stat = await lstat(current);
    if (
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (current === path && !directory ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      throw supervisorError();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Read fixed proc or trusted regular files without blocking on a FIFO or following the last link. */
export async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw supervisorError();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw supervisorError();
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

export function assertSupervisorRuntime(collector: boolean): void {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    process.geteuid?.() !== 0 ||
    process.execArgv.length !== 0 ||
    [
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR"
    ].some((key) => process.env[key] !== undefined) ||
    (!collector && process.stdin.isTTY)
  )
    throw supervisorError();
}

export async function assertHeartbeatPipe(runner: WatchdogProcessIdentity): Promise<void> {
  const pipe = await readlink("/proc/self/fd/0");
  if (!/^pipe:\[[0-9]+\]$/.test(pipe)) throw supervisorError();
  const ownInfo = (await boundedFile("/proc/self/fdinfo/0", 4096)).toString("utf8");
  const ownFlags = /^flags:\s+([0-7]+)$/m.exec(ownInfo);
  if (!ownFlags || (Number.parseInt(ownFlags[1]!, 8) & 3) !== 0) throw supervisorError();
  const iterator = await opendir(`/proc/${runner.pid}/fd`, { bufferSize: 16 });
  let count = 0;
  let writers = 0;
  try {
    for (;;) {
      const entry = await iterator.read();
      if (!entry) break;
      if (++count > 256 || !/^[0-9]+$/.test(entry.name)) throw supervisorError();
      if ((await readlink(`/proc/${runner.pid}/fd/${entry.name}`)) !== pipe) continue;
      const info = (await boundedFile(`/proc/${runner.pid}/fdinfo/${entry.name}`, 4096)).toString(
        "utf8"
      );
      const flags = /^flags:\s+([0-7]+)$/m.exec(info);
      if (!flags || (Number.parseInt(flags[1]!, 8) & 3) !== 1) throw supervisorError();
      writers++;
    }
  } finally {
    await iterator.close();
  }
  if (writers !== 1) throw supervisorError();
  await readComputerProcess(runner);
}

export async function assertNamespaceAnchors(config: SupervisorConfiguration): Promise<void> {
  await assertLinuxProc();
  if (
    (await boundedFile("/proc/sys/kernel/random/boot_id", 128)).toString("utf8").trim() !==
    config.bootId
  )
    throw supervisorError();
  for (const pid of ["self", "1"]) {
    const uidMap = (await boundedFile(`/proc/${pid}/uid_map`, 1024))
      .toString("utf8")
      .trim()
      .split(/\s+/);
    if (uidMap.join(",") !== "0,0,4294967295") throw supervisorError();
    for (const key of ["pid", "mnt", "user"] as const)
      if ((await readlink(`/proc/${pid}/ns/${key}`)) !== config.namespaces[key])
        throw supervisorError();
  }
}

export async function processIdentity(pid: number): Promise<WatchdogProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw supervisorError();
  const text = (await boundedFile(`/proc/${pid}/stat`, 8192)).toString("utf8");
  const fields = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  const identity = { pid, processGroupId: Number(fields[2]), startTicks: fields[19] ?? "" };
  await readComputerProcess(identity);
  return Object.freeze(identity);
}

export async function assertNullOutputs(pid: number): Promise<void> {
  for (const fd of [1, 2])
    if ((await readlink(`/proc/${pid}/fd/${fd}`)) !== "/dev/null") throw supervisorError();
}
const contains = (a: string, b: string) => {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export async function loadSupervisorDeployment(
  configPath: string,
  artifactPath: string,
  collector = false
): Promise<SupervisorDeployment> {
  try {
    assertSupervisorRuntime(collector);
    await assertTrustedPath(configPath, false);
    const metadata = await lstat(configPath);
    const parent = await lstat(dirname(configPath));
    if ((metadata.mode & 0o7777) !== 0o600 || (parent.mode & 0o7777) !== 0o700)
      throw supervisorError();
    const bytes = await boundedFile(configPath, 16384);
    const configuration = parseSupervisorConfiguration(JSON.parse(bytes.toString("utf8")));
    const nodePath = process.execPath;
    await assertTrustedPath(nodePath, false);
    await assertTrustedPath(artifactPath, false);
    if (sha256(await boundedFile(artifactPath, 2 * 1024 ** 2)) !== configuration.artifactSha256)
      throw supervisorError();
    await assertNamespaceAnchors(configuration);
    const roots = await inspectRoots(configuration.host);
    const dockerSocket = configuration.host.dockerSocket;
    await assertTrustedPath(dirname(dockerSocket), true);
    const socket = await lstat(dockerSocket);
    if (
      !socket.isSocket() ||
      socket.uid !== 0 ||
      socket.nlink !== 1 ||
      (socket.mode & 0o002) !== 0 ||
      (await realpath(dockerSocket)) !== dockerSocket
    )
      throw supervisorError();
    for (const root of [configuration.data, configuration.dockerData, configuration.monitor]) {
      await assertRoot(root);
      await assertTrustedPath(root.path, true);
    }
    if ((configuration.monitor.mode & 0o7777) !== 0o700) throw supervisorError();
    const all = [...roots, configuration.data, configuration.dockerData, configuration.monitor];
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!,
          b = all[j]!;
        for (const [ancestor, child] of [
          [a, b],
          [b, a]
        ]) {
          if (
            contains(ancestor!.path, child!.path) &&
            (ancestor!.path === child!.path ||
              ![configuration.data, configuration.dockerData].includes(ancestor!))
          )
            throw supervisorError();
        }
      }
    const marker = JSON.stringify({ config: configuration.host, roots });
    if (
      JSON.stringify(await privateJson(`${configuration.host.stateDir}/identity.json`)) !== marker
    )
      throw supervisorError();
    await assertNullOutputs(configuration.runner.pid);
    if (!collector) await assertNullOutputs(process.pid);
    await readComputerProcess(configuration.runner);
    if (!collector) await assertHeartbeatPipe(configuration.runner);
    return Object.freeze({
      configuration,
      configPath,
      configSha256: sha256(bytes),
      artifactPath,
      nodePath,
      roots: Object.freeze(roots),
      marker
    });
  } catch {
    throw supervisorError();
  }
}

export async function revalidateDeployment(
  deployment: SupervisorDeployment,
  collector = true
): Promise<void> {
  const current = await loadSupervisorDeployment(
    deployment.configPath,
    deployment.artifactPath,
    collector
  );
  if (
    current.configSha256 !== deployment.configSha256 ||
    current.marker !== deployment.marker ||
    current.nodePath !== deployment.nodePath
  )
    throw supervisorError();
}
