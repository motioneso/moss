/**
 * Release leases on the tools volume (#2689 slice 4, spec 6.5).
 *
 * A launcher writes one lease file per release it runs from, at
 * `providers/<slot>/leases/<release>/<pid>-<starttime>`. The start time is field 22 of
 * `/proc/<pid>/stat`, so a reused pid never makes a dead owner look alive. Cleanup keeps any
 * release that still has a live lease, so a running session never loses its files.
 */
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface LeaseTarget {
  readonly slot: string;
  /** Release folder name under `providers/<slot>/releases/`. */
  readonly release: string;
}

export interface LeaseHandle {
  /** Points the lease at the launched process, replacing the launcher's own pre-spawn lease. */
  readonly adopt: (pid: number) => Promise<void>;
  /** Deletes the lease files. Calls `onIdle` for each release left with no lease. */
  readonly release: () => Promise<void>;
}

/** Field 22 of `/proc/<pid>/stat`, or null when the process does not exist. */
export async function readProcStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may hold spaces, so count fields after the last ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return rest[19] ?? null;
  } catch {
    return null;
  }
}

const leaseDir = (prefix: string, t: LeaseTarget) =>
  path.join(prefix, "providers", t.slot, "leases", t.release);

async function writeLeaseFor(prefix: string, t: LeaseTarget, pid: number): Promise<string | null> {
  const start = await readProcStartTime(pid);
  if (start === null) return null;
  const dir = leaseDir(prefix, t);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${pid}-${start}`);
  await writeFile(file, "");
  return file;
}

/** Takes a lease on each release under the launcher's own pid. Throws if that cannot be written. */
export async function acquireLeases(
  prefix: string,
  targets: readonly LeaseTarget[],
  onIdle?: (target: LeaseTarget) => void | Promise<void>
): Promise<LeaseHandle> {
  const write = async (pid: number): Promise<string[]> => {
    const files: string[] = [];
    for (const t of targets) {
      const file = await writeLeaseFor(prefix, t, pid);
      if (file) files.push(file);
    }
    return files;
  };
  const remove = async (files: readonly string[]) => {
    for (const file of files) await rm(file, { force: true }).catch(() => undefined);
  };
  let held = await write(process.pid);
  return {
    adopt: async (pid) => {
      const before = held;
      held = await write(pid);
      await remove(before.filter((f) => !held.includes(f)));
    },
    release: async () => {
      await remove(held);
      held = [];
      for (const t of targets) {
        if (!(await hasLiveLease(prefix, t))) await onIdle?.(t);
      }
    }
  };
}

/** True when a lease on the release belongs to a running process. Stale leases are deleted. */
export async function hasLiveLease(prefix: string, t: LeaseTarget): Promise<boolean> {
  const dir = leaseDir(prefix, t);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  let live = false;
  for (const name of names) {
    const m = /^(\d+)-(\d+)$/.exec(name);
    const start = m ? await readProcStartTime(Number(m[1])) : null;
    if (m && start === m[2]) live = true;
    else await rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  if (!live) await rmdir(dir).catch(() => {});
  return live;
}

/**
 * The releases that a set of launch paths sit inside. Paths outside
 * `providers/<slot>/releases/<release>/` (the image copy) give no target.
 */
export function leaseTargetsForPaths(
  prefix: string,
  paths: readonly (string | undefined)[]
): LeaseTarget[] {
  let root: string;
  try {
    root = realpathSync(path.join(prefix, "providers"));
  } catch {
    return [];
  }
  const found = new Map<string, LeaseTarget>();
  for (const p of paths) {
    if (!p || !p.startsWith(root + path.sep)) continue;
    const [slot, folder, release] = p.slice(root.length + 1).split(path.sep);
    if (slot && release && folder === "releases") {
      found.set(`${slot}/${release}`, { slot, release });
    }
  }
  return [...found.values()];
}
