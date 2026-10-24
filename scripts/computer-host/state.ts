import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isGeneration, isRecord } from "../../apps/api/src/computer/host-contract.js";
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
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
function parseState(value: unknown): HostState {
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

/** Owns the one daemon lock, canonical storage identity and fsynced operation/resource state. */
export class HostStateStore {
  #state: HostState;
  private constructor(
    readonly config: HostConfig,
    readonly roots: RootIdentity[],
    private readonly lock: FileHandle,
    state: HostState
  ) {
    this.#state = state;
  }

  static async open(config: HostConfig): Promise<HostStateStore> {
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
      if (markerExists !== stateExists) throw new Error("Incomplete Computer host state");
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
      await store.close();
      throw error;
    }
  }
  get state(): HostState {
    return this.#state;
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
  async save(state: HostState): Promise<void> {
    parseState(state);
    await this.assertRoots();
    await this.#write("state.json", state);
    this.#state = state;
  }
  async #write(name: "state.json" | "identity.json", value: unknown): Promise<void> {
    const temporary = join(this.config.stateDir, `.state-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      await rename(temporary, join(this.config.stateDir, name));
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
  async close(): Promise<void> {
    const expected = await this.lock.stat();
    const path = join(this.config.stateDir, "daemon.lock");
    const actual = await lstat(path);
    if (expected.dev !== actual.dev || expected.ino !== actual.ino)
      throw new Error("Computer lock replaced");
    await unlink(path);
    await this.lock.close();
  }
}
