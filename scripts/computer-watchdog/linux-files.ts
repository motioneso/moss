import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath, statfs, type FileHandle } from "node:fs/promises";
import { boundedFile } from "./trust.js";
import { isAbsolute, normalize } from "node:path";
import type { RootIdentity } from "../computer-host/config.js";

export const measurementError = () => new Error("Computer Linux measurement unavailable");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const identityKeys = ["dev", "ino", "uid", "gid", "mode"] as const;

export function safeMeasurement(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw measurementError();
  return Number(value);
}

export async function assertLinuxProc(): Promise<void> {
  if (process.platform !== "linux" || (await statfs("/proc", { bigint: true })).type !== 0x9fa0n)
    throw measurementError();
}

export function snapshotRoot(value: RootIdentity): RootIdentity {
  const { path, dev, ino, uid, gid, mode } = value;
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    ![dev, ino, uid, gid, mode].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw measurementError();
  return Object.freeze({ path, dev, ino, uid, gid, mode });
}

function matchesRoot(stat: BigIntStats, root: RootIdentity): boolean {
  return stat.isDirectory() && identityKeys.every((key) => stat[key] === BigInt(root[key]));
}

export async function assertRoot(root: RootIdentity): Promise<void> {
  // TEMP-DEBUG
  if (process.env.PUB_DEBUG === "1")
    process.stderr.write(
      `ROOT ${JSON.stringify(root)} ${JSON.stringify(await lstat(root.path, { bigint: true }), (_k, v) => (typeof v === "bigint" ? String(v) : v))} ${await realpath(root.path)}\n`
    );
  if (
    !matchesRoot(await lstat(root.path, { bigint: true }), root) ||
    (await realpath(root.path)) !== root.path
  )
    throw measurementError();
}

export async function openRoot(root: RootIdentity): Promise<FileHandle> {
  await assertRoot(root);
  const file = await open(root.path, directoryFlags);
  try {
    if (!matchesRoot(await file.stat({ bigint: true }), root)) throw measurementError();
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export const descriptorPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;

/** Bounded sampled accounting, not a snapshot or quota. Never opens guest file contents. */
export async function measureComputerTree(value: RootIdentity): Promise<number> {
  try {
    const root = snapshotRoot(value);
    await assertLinuxProc();
    const file = await openRoot(root);
    let entries = 1;
    let total = 0n;
    const account = (stat: BigIntStats) => {
      if (stat.dev !== BigInt(root.dev) || stat.isBlockDevice() || stat.isCharacterDevice())
        throw measurementError();
      const allocated = stat.blocks * 512n;
      if (stat.size < 0n || allocated < 0n) throw measurementError();
      total += [stat.size, allocated, 4096n].reduce((a, b) => (a > b ? a : b));
      safeMeasurement(total);
    };
    const scan = async (directory: FileHandle, depth: number): Promise<void> => {
      if (depth > 32) throw measurementError();
      const iterator = await opendir(descriptorPath(directory), { bufferSize: 32 });
      try {
        for (;;) {
          const entry = await iterator.read();
          if (!entry) break;
          if (++entries > 100_000) throw measurementError();
          const name = entry.name;
          // Reject lossy UTF8 aliases before any lookup, including literal replacement names.
          if (/[\uFFFD/\0]/u.test(name) || name === "." || name === "..") throw measurementError();
          const path = `${descriptorPath(directory)}/${name}`;
          const stat = await lstat(path, { bigint: true });
          account(stat);
          if (!stat.isDirectory()) continue;
          const child = await open(path, directoryFlags);
          try {
            const opened = await child.stat({ bigint: true });
            if (!identityKeys.every((key) => stat[key] === opened[key])) throw measurementError();
            await scan(child, depth + 1);
          } finally {
            await child.close();
          }
        }
      } finally {
        await iterator.close();
      }
    };
    try {
      account(await file.stat({ bigint: true }));
      await scan(file, 0);
      await assertRoot(root);
      return safeMeasurement(total);
    } finally {
      await file.close();
    }
  } catch {
    throw measurementError();
  }
}

/** Linux descriptor mount identity also detects same-device bind mounts. */
export async function mountId(file: FileHandle): Promise<string> {
  const text = (await boundedFile(`/proc/self/fdinfo/${file.fd}`, 4096)).toString("utf8");
  const ids = [...text.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
  if (ids.length !== 1) throw measurementError();
  return ids[0]![1]!;
}
