import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { ROLES, type RootIdentity } from "./config.js";
import type { ComputerDocker, ComputerMutationGuard } from "./docker.js";
import { parseState, type HostState, type HostStateStore } from "./state.js";

export interface ComputerStopIntent {
  readonly schemaVersion: 1;
  readonly reason: "operator-stop";
  readonly instanceId: string;
  readonly roots: readonly RootIdentity[];
  readonly state: HostState;
}
export interface StopReceipt {
  readonly intent: ComputerStopIntent;
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
}
export interface ComputerRecoveryResult {
  readonly operation: "inspect" | "stop";
  readonly terminal: boolean;
  /** Local Docker protocol observation only, not independent resource closure. */
  readonly remainingResources: number;
}
const stopPath = (store: HostStateStore) => join(store.config.stateDir, "stop.json");
const failure = () => new Error("Computer terminal reconciliation unavailable");

function compatible(store: HostStateStore, intent: ComputerStopIntent): void {
  const current = store.state;
  if (
    current.generation < intent.state.generation ||
    current.resources.length !== intent.state.resources.length ||
    current.resources.some(
      (resource) =>
        !intent.state.resources.some(
          (original) =>
            resource.role === original.role &&
            resource.generation === original.generation &&
            (original.id === null || original.id === resource.id)
        )
    )
  )
    throw failure();
}

async function readStop(store: HostStateStore, sync = false): Promise<StopReceipt> {
  const path = stopPath(store);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  store.latchStop();
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 16_384
    )
      throw failure();
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size || bytesRead > 16_384) throw failure();
    const bytes = buffer.subarray(0, bytesRead);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "instanceId,reason,roots,schemaVersion,state" ||
      value.schemaVersion !== 1 ||
      value.reason !== "operator-stop" ||
      value.instanceId !== store.config.instanceId ||
      JSON.stringify(value.roots) !== JSON.stringify(store.roots)
    )
      throw failure();
    const intent: ComputerStopIntent = {
      schemaVersion: 1,
      reason: "operator-stop",
      instanceId: store.config.instanceId,
      roots: store.roots,
      state: parseState(value.state)
    };
    compatible(store, intent);
    if (sync) {
      await file.sync();
      const directory = await open(
        store.config.stateDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    const actual = await lstat(path);
    if (actual.dev !== stat.dev || actual.ino !== stat.ino) throw failure();
    await store.assertRoots();
    return { intent, bytes, dev: stat.dev, ino: stat.ino };
  } finally {
    await file.close();
  }
}

async function assertStop(store: HostStateStore, receipt: StopReceipt): Promise<void> {
  const current = await readStop(store);
  if (
    current.dev !== receipt.dev ||
    current.ino !== receipt.ino ||
    !current.bytes.equals(receipt.bytes)
  )
    throw failure();
}

/** Terminal before I/O. Existing marker bytes are never overwritten or treated as a prior fsync ack. */
export async function persistComputerStop(store: HostStateStore): Promise<StopReceipt> {
  store.latchStop();
  await store.assertRoots();
  let file;
  try {
    file = await open(
      stopPath(store),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
  } catch (error) {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  }
  if (file) {
    try {
      const intent: ComputerStopIntent = {
        schemaVersion: 1,
        reason: "operator-stop",
        instanceId: store.config.instanceId,
        roots: store.roots,
        state: store.state
      };
      const bytes = JSON.stringify(intent);
      if (Buffer.byteLength(bytes) > 16_384) throw failure();
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
  }
  return readStop(store, true);
}

/** Existing state only; no persistence or Docker mutation. */
export async function inspectComputerRecovery(
  store: HostStateStore,
  docker: ComputerDocker
): Promise<ComputerRecoveryResult> {
  await store.assertRoots();
  const marker = await readStop(store).catch((error: unknown) => {
    if (!store.stopRequested && isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  });
  const before = JSON.stringify(store.state);
  const inventory = await docker.inventory(store.state.resources);
  await store.assertRoots();
  if (before !== JSON.stringify(store.state)) throw failure();
  if (marker) await assertStop(store, marker);
  else await store.assertLaunchable();
  return { operation: "inspect", terminal: marker !== null, remainingResources: inventory.length };
}

/** Explicit fixed forced stop, never launch/reset/lock takeover or an independent closure receipt. */
export async function stopComputerRecovery(
  store: HostStateStore,
  docker: ComputerDocker
): Promise<ComputerRecoveryResult> {
  const receipt = await persistComputerStop(store);
  return reconcileComputerStop(store, docker, receipt);
}

/** Shared exact cleanup. Normal callers additionally require their actual supervisor fence. */
export async function reconcileComputerStop(
  store: HostStateStore,
  docker: ComputerDocker,
  receipt: StopReceipt,
  assertCurrent: () => void = () => {}
): Promise<ComputerRecoveryResult> {
  assertCurrent();
  await assertStop(store, receipt);
  if (store.state.generation === Number.MAX_SAFE_INTEGER) throw failure();
  let state = JSON.stringify(store.state);
  const guard: ComputerMutationGuard = {
    check: () => assertStop(store, receipt),
    assertCurrent() {
      assertCurrent();
      if (JSON.stringify(store.state) !== state) throw failure();
    }
  };
  await store.save(
    { ...store.state, enabled: false, generation: store.state.generation + 1 },
    guard
  );
  state = JSON.stringify(store.state);
  const inventory = await docker.inventory(store.state.resources);
  await assertStop(store, receipt);
  const resources = store.state.resources.map(
    (resource) =>
      inventory.find((entry) => entry.resource.role === resource.role)?.resource ?? resource
  );
  await store.save({ ...store.state, resources }, guard);
  state = JSON.stringify(store.state);
  for (const role of ROLES) {
    const entry = inventory.find((resource) => resource.resource.role === role);
    if (entry) await docker.remove(entry.resource, guard);
  }
  const remaining = await docker.inventory(store.state.resources);
  await assertStop(store, receipt);
  guard.assertCurrent();
  if (remaining.length !== 0) throw failure();
  return { operation: "stop", terminal: true, remainingResources: 0 };
}
