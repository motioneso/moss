import { join } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/host-contract.js";
import { parseComputerLifetime } from "../../apps/api/src/computer/lifetime-protocol.js";
import { captureNamespaceAnchors } from "../computer-capture/cgroups.js";
import { snapshotRoot } from "../computer-watchdog/linux-files.js";
import { snapshotProcess } from "../computer-watchdog/linux.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";
import { sha256, supervisorError } from "../computer-watchdog/trust.js";
import type { RootIdentity } from "../computer-host/config.js";
import type { ClosureConfiguration } from "./config.js";
import { closureFile, type ClosureFile } from "./files.js";
import { signingHash } from "../computer-signing/installation.js";

export interface ClosureCapture {
  readonly file: ClosureFile;
  readonly measuredAtMs: number;
  readonly finishedAtMs: number;
  readonly journal: Readonly<{ dev: number; ino: number; size: number; hash: string }>;
}
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function identity(value: unknown): WatchdogProcessIdentity {
  if (!gatewayFields(value, "pid,processGroupId,startTicks")) throw supervisorError();
  return snapshotProcess(value as unknown as WatchdogProcessIdentity);
}
const sameIdentity = (value: unknown, expected: WatchdogProcessIdentity): boolean => {
  const actual = identity(value);
  return (Object.keys(actual) as (keyof WatchdogProcessIdentity)[]).every(
    (key) => actual[key] === expected[key]
  );
};
function roots(value: unknown): readonly RootIdentity[] {
  if (!Array.isArray(value)) throw supervisorError();
  return value.map((root: unknown) => {
    if (!gatewayFields(root, "dev,gid,ino,mode,path,uid")) throw supervisorError();
    return snapshotRoot(root as unknown as RootIdentity);
  });
}

/** Historical sampled init provenance only; no live process, state, lock or heartbeat lookup. */
export async function loadClosureCapture(
  configuration: ClosureConfiguration,
  deploymentRoots: readonly RootIdentity[]
): Promise<ClosureCapture> {
  const { supervisor } = configuration;
  if (!supervisor.capture || !supervisor.lifetime) throw supervisorError();
  const file = await closureFile(join(supervisor.capture.path, "capture.json"), 64 * 1024);
  if (file.hash !== configuration.captureSha256) throw supervisorError();
  const value: unknown = JSON.parse(file.bytes.toString("utf8"));
  if (
    !gatewayFields(
      value,
      "binding,coverage,finishedAtMs,groups,inits,journal,kind,measuredAtMs,provenance,runId,runner,version,watchdog"
    ) ||
    value.version !== 1 ||
    value.kind !== "managed-process-snapshot" ||
    value.coverage !== "sampled-cgroup-v2" ||
    value.runId !== supervisor.runId ||
    !integer(value.measuredAtMs) ||
    !integer(value.finishedAtMs) ||
    value.finishedAtMs < value.measuredAtMs ||
    !sameIdentity(value.runner, supervisor.runner) ||
    !sameIdentity(value.watchdog, configuration.processes.watchdog)
  )
    throw supervisorError();
  const binding = parseComputerLifetime({
    binding: value.binding,
    secret: supervisor.lifetime.secret
  }).binding;
  if (JSON.stringify(binding) !== JSON.stringify(supervisor.lifetime.binding))
    throw supervisorError();
  if (!Array.isArray(value.inits) || value.inits.length !== 2) throw supervisorError();
  const roles = new Set<string>();
  for (const init of value.inits as unknown[]) {
    if (
      !gatewayFields(init, "id,identity,pid,role,startedAt") ||
      (init.role !== "desktop" && init.role !== "gateway") ||
      roles.has(init.role) ||
      init.id !== (init.role === "desktop" ? binding.desktopId : binding.gatewayId) ||
      typeof init.startedAt !== "string" ||
      !init.startedAt.trim() ||
      !Number.isFinite(Date.parse(init.startedAt)) ||
      !sameIdentity(init.identity, configuration.processes[init.role]) ||
      init.pid !== identity(init.identity).pid
    )
      throw supervisorError();
    roles.add(init.role);
  }
  const p = value.provenance;
  const g = value.groups;
  if (
    !gatewayFields(p, "bootId,files,lock,namespaces,roots,socket") ||
    p.bootId !== supervisor.bootId ||
    !gatewayFields(p.namespaces, "cgroup,mnt,net,pid,user") ||
    !gatewayFields(g, "mountId,namespaces,pair,root") ||
    !gatewayFields(g.namespaces, "cgroup,net") ||
    JSON.stringify(roots(p.roots)) !== JSON.stringify(deploymentRoots)
  )
    throw supervisorError();
  for (const key of ["pid", "mnt", "user", "net", "cgroup"] as const) {
    const namespace = p.namespaces[key];
    if (typeof namespace !== "string" || !new RegExp(`^${key}:\\[[0-9]+\\]$`).test(namespace))
      throw supervisorError();
    if (
      key === "net"
        ? namespace !== configuration.netNamespace
        : key !== "cgroup" && namespace !== supervisor.namespaces[key]
    )
      throw supervisorError();
  }
  const anchors = await captureNamespaceAnchors();
  for (const key of ["net", "cgroup"] as const)
    if (g.namespaces[key] !== p.namespaces[key] || anchors[key] !== p.namespaces[key])
      throw supervisorError();
  const j = value.journal;
  if (
    !gatewayFields(j, "dev,hash,ino,size") ||
    !integer(j.dev) ||
    !integer(j.ino) ||
    j.ino === 0 ||
    !integer(j.size) ||
    j.size === 0 ||
    j.size > 4096 ||
    !signingHash(j.hash)
  )
    throw supervisorError();
  return Object.freeze({
    file,
    measuredAtMs: value.measuredAtMs,
    finishedAtMs: value.finishedAtMs,
    journal: Object.freeze({ dev: j.dev, ino: j.ino, size: j.size, hash: j.hash })
  });
}

/** The captured start prefix binds origin while the same journal may append final records. */
export function assertCaptureJournal(capture: ClosureCapture, journal: ClosureFile): void {
  const end = journal.bytes.indexOf(10) + 1;
  const prefix = journal.bytes.subarray(0, end);
  if (
    journal.dev !== capture.journal.dev ||
    journal.ino !== capture.journal.ino ||
    end !== capture.journal.size ||
    sha256(prefix) !== capture.journal.hash
  )
    throw supervisorError();
  const first: unknown = JSON.parse(prefix.toString("utf8"));
  if (
    !gatewayFields(first, "configuration,type") ||
    first.type !== "start" ||
    !gatewayFields(first.configuration, "runId,runner,startedAtMs,watchdog") ||
    !integer(first.configuration.startedAtMs) ||
    first.configuration.startedAtMs > capture.measuredAtMs ||
    capture.finishedAtMs < capture.measuredAtMs ||
    capture.finishedAtMs - first.configuration.startedAtMs >= 5000
  )
    throw supervisorError();
}
