import { constants, renameSync, unlinkSync } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isGeneration, isRecord } from "../../apps/api/src/computer/host-contract.js";
import type { ComputerMutationGuard } from "./docker.js";
import {
  inspectRoots,
  ROLES,
  type HostConfig,
  type ComputerRole,
  type RootIdentity
} from "./config.js";

export interface HostResource {
  readonly role: ComputerRole;
  readonly generation: number;
  /** null is a durable creation intent, not evidence that a container is absent. */
  readonly id: string | null;
}
export interface HostState {
  readonly generation: number;
  readonly enabled: boolean;
  readonly resources: readonly HostResource[];
}
export const fullDockerId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

export async function privateJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 16_384
    )
      throw new Error("Unsafe host state file");
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error("Host state file too large");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
export function parseState(value: unknown): HostState {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "enabled,generation,resources" ||
    !isGeneration(value.generation) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.resources) ||
    value.resources.length > 2
  )
    throw new Error("Invalid host state");
  const roles = new Set<unknown>();
  for (const resource of value.resources) {
    if (
      !isRecord(resource) ||
      Object.keys(resource).sort().join(",") !== "generation,id,role" ||
      !ROLES.includes(resource.role as ComputerRole) ||
      !isGeneration(resource.generation) ||
      resource.generation > value.generation ||
      !(resource.id === null || fullDockerId(resource.id)) ||
      roles.has(resource.role)
    )
      throw new Error("Invalid host resource");
    roles.add(resource.role);
  }
  return value as unknown as HostState;
}

export class TerminalStateConflict extends Error {}

/** Owns the one daemon lock, canonical storage identity and fsynced operation/resource state. */
export class HostStateStore {
  #state: HostState;
  #stopRequested = false;
  private constructor(
    readonly config: HostConfig,
    readonly roots: RootIdentity[],
    private readonly lock: FileHandle,
    state: HostState
  ) {
    this.#state = state;
  }

  static async open(config: HostConfig): Promise<HostStateStore> {
    return this.#open(config, true);
  }
  static async openExisting(
    config: HostConfig,
    options?: { readonly retainFailedLock: true }
  ): Promise<HostStateStore> {
    return this.#open(config, false, options?.retainFailedLock ?? false);
  }
  static async #open(
    config: HostConfig,
    initialize: boolean,
    retainFailedLock = false
  ): Promise<HostStateStore> {
    const roots = await inspectRoots(config);
    const lockPath = join(config.stateDir, "daemon.lock");
    const lock = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    const store = new HostStateStore(config, roots, lock, {
      generation: 0,
      enabled: false,
      resources: []
    });
    try {
      const markerPath = join(config.stateDir, "identity.json");
      const statePath = join(config.stateDir, "state.json");
      const markerExists = await exists(markerPath);
      const stateExists = await exists(statePath);
      store.#stopRequested = await exists(join(config.stateDir, "stop.json"));
      if (markerExists !== stateExists) throw new Error("Incomplete Computer host state");
      if (!markerExists && (!initialize || store.#stopRequested))
        throw new Error("Existing Computer host state required");
      const marker = { config, roots };
      if (markerExists) {
        if (JSON.stringify(await privateJson(markerPath)) !== JSON.stringify(marker))
          throw new Error("Computer storage identity changed");
        store.#state = parseState(await privateJson(statePath));
      } else {
        await store.#write("state.json", store.#state);
        await store.#write("identity.json", marker);
      }
      return store;
    } catch (error) {
      if (retainFailedLock) await store.retainLock();
      else await store.close();
      throw error;
    }
  }
  get state(): HostState {
    return this.#state;
  }
  get stopRequested(): boolean {
    return this.#stopRequested;
  }
  latchStop(): void {
    this.#stopRequested = true;
  }
  assertNotStopped(): void {
    if (this.#stopRequested) throw new Error("Computer lifecycle is terminal");
  }
  async assertLaunchable(): Promise<void> {
    this.assertNotStopped();
    if (await exists(join(this.config.stateDir, "stop.json"))) this.latchStop();
    this.assertNotStopped();
  }
  async assertRoots(): Promise<void> {
    if (JSON.stringify(await inspectRoots(this.config)) !== JSON.stringify(this.roots))
      throw new Error("Computer roots replaced");
    // Re-read durable files so missing, replaced or symlinked state never silently resets CAS.
    if (
      JSON.stringify(await privateJson(join(this.config.stateDir, "state.json"))) !==
        JSON.stringify(this.#state) ||
      JSON.stringify(await privateJson(join(this.config.stateDir, "identity.json"))) !==
        JSON.stringify({ config: this.config, roots: this.roots })
    )
      throw new Error("Computer state changed");
  }
  #assertTerminalState(state: HostState): void {
    if (
      this.#stopRequested &&
      (state.enabled ||
        state.generation < this.#state.generation ||
        state.resources.length !== this.#state.resources.length ||
        this.#state.resources.some(
          (before) =>
            !state.resources.some(
              (after) =>
                before.role === after.role &&
                before.generation === after.generation &&
                (before.id === null || before.id === after.id)
            )
        ))
    )
      throw new TerminalStateConflict("Terminal Computer identities must be retained");
  }
  async save(state: HostState, guard?: ComputerMutationGuard): Promise<void> {
    parseState(state);
    this.#assertTerminalState(state);
    await this.assertRoots();
    guard?.assertCurrent();
    await this.#write("state.json", state, guard);
  }
  async #write(
    name: "state.json" | "identity.json",
    value: unknown,
    guard?: ComputerMutationGuard
  ): Promise<void> {
    const temporary = join(this.config.stateDir, `.state-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      if (guard) await guard.check();
      const state = name === "state.json" ? parseState(value) : null;
      if (state) this.#assertTerminalState(state);
      guard?.assertCurrent();
      // No await between terminal validation, durable-path publication and local state publication.
      // A terminal latch during the following directory fsync observes this same state.
      renameSync(temporary, join(this.config.stateDir, name));
      if (state) this.#state = state;
      const directory = await open(
        this.config.stateDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await file.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      });
    }
  }
  /** Read-only proof of this store's still-open exclusive descriptor and canonical path. */
  async ownedLock() {
    const opened = await this.lock.stat();
    const actual = await lstat(join(this.config.stateDir, "daemon.lock"));
    const keys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const;
    if (
      !opened.isFile() ||
      opened.uid !== process.getuid!() ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.nlink !== 1 ||
      opened.size !== 0 ||
      !actual.isFile() ||
      keys.some((key) => actual[key] !== opened[key])
    )
      throw new Error("Computer lock changed");
    return Object.fromEntries(keys.map((key) => [key, opened[key]]));
  }
  /** Release only the descriptor, retaining the exclusive path for explicit recovery. */
  async retainLock(): Promise<void> {
    await this.lock.close();
  }
  async close(guard?: ComputerMutationGuard): Promise<void> {
    const expected = await this.lock.stat();
    const path = join(this.config.stateDir, "daemon.lock");
    // O_EXCL path ownership is the lock. Close failure must leave that path retained.
    await this.lock.close();
    if (guard) await guard.check();
    const actual = await lstat(path);
    if (expected.dev !== actual.dev || expected.ino !== actual.ino)
      throw new Error("Computer lock replaced");
    guard?.assertCurrent();
    // No fallible async work after this guarded final release.
    unlinkSync(path);
  }
}
