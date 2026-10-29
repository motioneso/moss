import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";
import type { RootIdentity } from "../computer-host/config.js";
import {
  COMPUTER_WATCHDOG_LIMITS,
  type WatchdogProcessIdentity,
  type WatchdogProcessSample,
  type WatchdogSample
} from "./policy.js";
import {
  assertLinuxProc,
  assertRoot,
  descriptorPath,
  measureComputerTree,
  measurementError,
  openRoot,
  safeMeasurement,
  snapshotRoot
} from "./linux-files.js";

export type ComputerLinuxMeasurements = Pick<
  WatchdogSample,
  | "measuredAtMs"
  | "runner"
  | "watchdog"
  | "availableMemoryBytes"
  | "rootAvailableBytes"
  | "dataAvailableBytes"
  | "homeBytes"
  | "socketBytes"
>;

export interface ComputerLinuxConfiguration {
  readonly runner: WatchdogProcessIdentity;
  readonly watchdog: WatchdogProcessIdentity;
  readonly home: RootIdentity;
  readonly socket: RootIdentity;
  readonly data: RootIdentity;
}

export function computerMonotonicMs(): number {
  return safeMeasurement(process.hrtime.bigint() / 1_000_000n);
}

export function snapshotProcess(value: WatchdogProcessIdentity): WatchdogProcessIdentity {
  const { pid, startTicks, processGroupId } = value;
  if (
    ![pid, processGroupId].every((n) => Number.isSafeInteger(n) && n > 0) ||
    typeof startTicks !== "string" ||
    !/^[0-9]{1,20}$/.test(startTicks) ||
    /^0+$/.test(startTicks)
  )
    throw measurementError();
  return Object.freeze({ pid, startTicks, processGroupId });
}

async function readProc(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw measurementError();
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw measurementError();
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

/** Repeated OS observation; no guarantee the process stays live after return. */
export async function readComputerProcess(
  value: WatchdogProcessIdentity
): Promise<WatchdogProcessSample> {
  try {
    const expected = snapshotProcess(value);
    await assertLinuxProc();
    const text = await readProc(`/proc/${expected.pid}/stat`, 8192);
    const boundary = text.lastIndexOf(")");
    const prefix = text.slice(0, text.indexOf("("));
    const fields = text
      .slice(boundary + 1)
      .trim()
      .split(/\s+/);
    if (
      boundary < 0 ||
      prefix !== `${expected.pid} ` ||
      !["R", "S", "D"].includes(fields[0] ?? "") ||
      fields[2] !== String(expected.processGroupId) ||
      fields[19] !== expected.startTicks
    )
      throw measurementError();
    return Object.freeze({ ...expected, state: "running" });
  } catch {
    throw measurementError();
  }
}

async function availableMemory(): Promise<number> {
  const lines = (await readProc("/proc/meminfo", 65_536))
    .split("\n")
    .filter((line) => line.startsWith("MemAvailable:"));
  const match = lines.length === 1 ? /^MemAvailable:\s+([0-9]+)\s+kB$/.exec(lines[0]!) : null;
  if (!match) throw measurementError();
  return safeMeasurement(BigInt(match[1]!) * 1024n);
}

async function availableDisk(path: string): Promise<number> {
  const stat = await statfs(path, { bigint: true });
  if (stat.bavail < 0n || stat.bsize <= 0n) throw measurementError();
  return safeMeasurement(stat.bavail * stat.bsize);
}

/** Partial measurement only. Complete trusted supervision and admission remain unimplemented. */
export async function collectComputerLinuxMeasurements(
  value: ComputerLinuxConfiguration
): Promise<ComputerLinuxMeasurements> {
  const measuredAtMs = computerMonotonicMs();
  try {
    if (process.platform !== "linux" || process.geteuid?.() !== 0) throw measurementError();
    const runner = snapshotProcess(value.runner);
    const watchdog = snapshotProcess(value.watchdog);
    const home = snapshotRoot(value.home);
    const socket = snapshotRoot(value.socket);
    const data = snapshotRoot(value.data);
    if (runner.pid === watchdog.pid || runner.processGroupId === watchdog.processGroupId)
      throw measurementError();
    await readComputerProcess(runner);
    await readComputerProcess(watchdog);
    const availableMemoryBytes = await availableMemory();
    const rootAvailableBytes = await availableDisk("/");
    const directory = await openRoot(data);
    let dataAvailableBytes: number;
    try {
      dataAvailableBytes = await availableDisk(descriptorPath(directory));
    } finally {
      await directory.close();
    }
    const homeBytes = await measureComputerTree(home);
    const socketBytes = await measureComputerTree(socket);
    const runnerSample = await readComputerProcess(runner);
    const watchdogSample = await readComputerProcess(watchdog);
    for (const root of [data, home, socket]) await assertRoot(root);
    if (computerMonotonicMs() - measuredAtMs >= COMPUTER_WATCHDOG_LIMITS.sampleIntervalMs)
      throw measurementError();
    return Object.freeze({
      measuredAtMs,
      runner: runnerSample,
      watchdog: watchdogSample,
      availableMemoryBytes,
      rootAvailableBytes,
      dataAvailableBytes,
      homeBytes,
      socketBytes
    });
  } catch {
    throw measurementError();
  }
}
