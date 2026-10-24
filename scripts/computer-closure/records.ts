import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/host-contract.js";
import { parseState, type HostState } from "../computer-host/state.js";
import { snapshotProcess } from "../computer-watchdog/linux.js";
import { supervisorError } from "../computer-watchdog/trust.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";
import type { ClosureDeployment } from "./config.js";
import { closureFile, recheckClosureFile, type ClosureFile } from "./files.js";

export interface ClosureRecords {
  readonly files: readonly ClosureFile[];
  readonly state: HostState;
  readonly collectors: readonly WatchdogProcessIdentity[];
  readonly lockPresent: boolean;
}
export const sameProcess = (a: WatchdogProcessIdentity, b: WatchdogProcessIdentity) =>
  a.pid === b.pid && a.startTicks === b.startTicks && a.processGroupId === b.processGroupId;
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function identity(v: unknown): WatchdogProcessIdentity {
  if (!gatewayFields(v, "pid,processGroupId,startTicks")) throw supervisorError();
  return snapshotProcess(v as unknown as WatchdogProcessIdentity);
}

/** Journal identities are inputs to native absence checks, never evidence of closure. */
export function closureCollectors(
  bytes: Buffer,
  deployment: ClosureDeployment
): WatchdogProcessIdentity[] {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || !text.endsWith("\n") || bytes.length > 512 * 1024)
    throw supervisorError();
  const lines = text.slice(0, -1).split("\n");
  if (
    lines.length < 2 ||
    lines.length > 802 ||
    lines.some((line) => Buffer.byteLength(line) > 4096)
  )
    throw supervisorError();
  const { supervisor, processes } = deployment.configuration;
  const records: unknown[] = lines.map((line) => JSON.parse(line));
  const first = records[0],
    last = records.at(-1);
  if (
    !gatewayFields(first, "configuration,type") ||
    first.type !== "start" ||
    !gatewayFields(first.configuration, "runId,runner,startedAtMs,watchdog") ||
    first.configuration.runId !== supervisor.runId ||
    !integer(first.configuration.startedAtMs) ||
    !sameProcess(identity(first.configuration.runner), supervisor.runner) ||
    !sameProcess(identity(first.configuration.watchdog), processes.watchdog) ||
    !gatewayFields(last, "atMs,collector,collectorPid,reason,type") ||
    last.type !== "stop" ||
    !integer(last.atMs) ||
    last.atMs < first.configuration.startedAtMs ||
    typeof last.reason !== "string" ||
    ![
      "clock-invalid",
      "run-deadline",
      "heartbeat-expired",
      "sample-expired",
      "measurement-failed",
      "identity-changed",
      "moss-unhealthy",
      "logs-unbounded",
      "resource-floor",
      "home-limit",
      "operator-stop"
    ].includes(last.reason)
  )
    throw supervisorError();
  const collectors: WatchdogProcessIdentity[] = [];
  let samples = 0,
    count = 0,
    lastTime = first.configuration.startedAtMs;
  for (const record of records.slice(1, -1)) {
    if (gatewayFields(record, "identity,type") && record.type === "collector") {
      if (++count > 400) throw supervisorError();
      collectors.push(identity(record.identity));
      continue;
    }
    if (!gatewayFields(record, "sample,type") || record.type !== "sample" || ++samples > 400)
      throw supervisorError();
    const s = record.sample;
    if (
      !gatewayFields(
        s,
        "availableMemoryBytes,dataAvailableBytes,homeBytes,logsBounded,measuredAtMs,mossHealthy,rootAvailableBytes,runId,runner,socketBytes,stopRequested,watchdog"
      ) ||
      s.runId !== supervisor.runId ||
      !integer(s.measuredAtMs) ||
      s.measuredAtMs < lastTime ||
      ![
        s.availableMemoryBytes,
        s.dataAvailableBytes,
        s.homeBytes,
        s.rootAvailableBytes,
        s.socketBytes
      ].every(integer) ||
      ![s.logsBounded, s.mossHealthy, s.stopRequested].every((v) => typeof v === "boolean")
    )
      throw supervisorError();
    for (const [value, expected] of [
      [s.runner, supervisor.runner],
      [s.watchdog, processes.watchdog]
    ] as const) {
      if (
        !gatewayFields(value, "pid,processGroupId,startTicks,state") ||
        value.state !== "running" ||
        !sameProcess(snapshotProcess(value as unknown as WatchdogProcessIdentity), expected)
      )
        throw supervisorError();
    }
    lastTime = s.measuredAtMs;
  }
  if (last.collector !== null) {
    const collector = identity(last.collector);
    if (last.collectorPid !== collector.pid) throw supervisorError();
    collectors.push(collector);
  } else if (last.collectorPid !== null) throw supervisorError();
  return collectors;
}

export async function readClosureRecords(deployment: ClosureDeployment): Promise<ClosureRecords> {
  const { supervisor } = deployment.configuration;
  const files = await Promise.all(
    ["identity.json", "state.json", "stop.json"].map((name) =>
      closureFile(join(supervisor.host.stateDir, name), 16384)
    )
  );
  const [markerFile, stateFile, stopFile] = files;
  if (
    JSON.stringify(JSON.parse(markerFile!.bytes.toString("utf8"))) !==
    JSON.stringify({ config: supervisor.host, roots: deployment.roots })
  )
    throw supervisorError();
  const state = parseState(JSON.parse(stateFile!.bytes.toString("utf8")));
  const stop: unknown = JSON.parse(stopFile!.bytes.toString("utf8"));
  if (
    !gatewayFields(stop, "instanceId,reason,roots,schemaVersion,state") ||
    stop.schemaVersion !== 1 ||
    stop.reason !== "operator-stop" ||
    stop.instanceId !== supervisor.host.instanceId ||
    JSON.stringify(stop.roots) !== JSON.stringify(deployment.roots)
  )
    throw supervisorError();
  const original = parseState(stop.state);
  const binding = supervisor.lifetime!.binding;
  const boundResources = (s: HostState) =>
    s.resources.length === 2 &&
    s.resources.every(
      (r) =>
        r.id === (r.role === "desktop" ? binding.desktopId : binding.gatewayId) &&
        r.generation ===
          (r.role === "desktop" ? binding.desktopGeneration : binding.gatewayGeneration)
    );
  if (
    state.enabled ||
    state.generation < original.generation ||
    original.generation !== binding.requestGeneration ||
    !boundResources(state) ||
    !boundResources(original)
  )
    throw supervisorError();
  const journal = await closureFile(join(supervisor.monitor.path, "observation.jsonl"), 512 * 1024);
  const collectors = closureCollectors(journal.bytes, deployment);
  let lockPresent = false;
  try {
    await lstat(join(supervisor.host.stateDir, "daemon.lock"));
    lockPresent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw supervisorError();
  }
  return { files: [...files, journal], state, collectors, lockPresent };
}

export async function recheckClosureRecords(records: ClosureRecords): Promise<void> {
  for (const file of records.files) await recheckClosureFile(file);
}
