import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, readlink, statfs, type FileHandle } from "node:fs/promises";
import {
  assertTrustedPath,
  boundedFile,
  processIdentity,
  supervisorError
} from "../computer-watchdog/trust.js";
import { descriptorPath, mountId } from "../computer-watchdog/linux-files.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";

const ROOT = "/sys/fs/cgroup";
const flags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const keys = ["dev", "ino", "uid", "gid", "mode"] as const;
const metadata = (stat: Stats) => Object.fromEntries(keys.map((key) => [key, stat[key]]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const inside = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);

/** Extra host namespace anchors: proc cgroup paths are relative to the cgroup namespace. */
export async function captureNamespaceAnchors() {
  const result: Record<string, string> = {};
  for (const key of ["net", "cgroup"] as const) {
    const own = await readlink(`/proc/self/ns/${key}`);
    if (
      !new RegExp(`^${key}:\\[[0-9]+\\]$`).test(own) ||
      own !== (await readlink(`/proc/1/ns/${key}`))
    )
      throw supervisorError();
    result[key] = own;
  }
  return result;
}

export async function processCgroup(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw supervisorError();
  const bytes = await boundedFile(`/proc/${pid}/cgroup`, 16384);
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text).equals(bytes) ||
    !/^0::\/(?:[A-Za-z0-9_.:@-]+\/)*[A-Za-z0-9_.:@-]+\n$/.test(text)
  )
    throw supervisorError();
  const path = text.slice(3, -1);
  if (path.split("/").some((part) => part === "." || part === "..")) throw supervisorError();
  return path;
}
export interface CgroupProcess extends WatchdogProcessIdentity {
  readonly cgroup: string;
}

/** Repeated samples are checked by the caller; this never claims continuous descendant coverage. */
export async function captureCgroupPair(
  inits: readonly { id: string; pid: number; role: "gateway" | "desktop" }[],
  host: readonly WatchdogProcessIdentity[]
) {
  if (inits.length !== 2 || new Set(inits.map((i) => i.role)).size !== 2) throw supervisorError();
  const before = await captureNamespaceAnchors();
  await assertTrustedPath(ROOT, true);
  if ((await statfs(ROOT, { bigint: true })).type !== 0x63677270n) throw supervisorError();
  const root = await open(ROOT, flags);
  try {
    const rootStat = await root.stat();
    const rootMount = await mountId(root);
    const paths = await Promise.all(inits.map((init) => processCgroup(init.pid)));
    for (let i = 0; i < paths.length; i++) {
      const init = inits[i]!;
      if (
        !/^[0-9a-f]{64}$/.test(init.id) ||
        ![init.id, `docker-${init.id}.scope`].includes(paths[i]!.split("/").at(-1)!)
      )
        throw supervisorError();
    }
    if (inside(paths[0]!, paths[1]!) || inside(paths[1]!, paths[0]!)) throw supervisorError();
    for (const identity of host) {
      const path = await processCgroup(identity.pid);
      if (paths.some((container) => inside(container, path))) throw supervisorError();
      if (!same(await processIdentity(identity.pid), identity)) throw supervisorError();
    }
    const check = async (file: FileHandle, expected: Stats, directory: boolean) => {
      const stat = await file.stat();
      if (
        (directory ? !stat.isDirectory() : !stat.isFile()) ||
        stat.dev !== rootStat.dev ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        !same(metadata(stat), metadata(expected)) ||
        (await mountId(file)) !== rootMount
      )
        throw supervisorError();
      return stat;
    };
    const pair = [];
    const allPids = new Set<number>();
    for (let i = 0; i < inits.length; i++) {
      const init = inits[i]!;
      const path = paths[i]!;
      const handles: FileHandle[] = [];
      const ancestors: { parent: FileHandle; name: string; stat: Stats }[] = [];
      let directory = root;
      try {
        const parts = path.slice(1).split("/");
        if (parts.length > 32) throw supervisorError();
        for (const name of parts) {
          const childPath = `${descriptorPath(directory)}/${name}`;
          const stat = await lstat(childPath);
          const child = await open(childPath, flags);
          handles.push(child);
          await check(child, stat, true);
          ancestors.push({ parent: directory, name, stat });
          directory = child;
        }
        let entries = 0;
        const directories: { path: string; metadata: ReturnType<typeof metadata> }[] = [];
        const processes: CgroupProcess[] = [];
        const scan = async (dir: FileHandle, group: string, depth: number): Promise<void> => {
          if (depth > 8 || ++entries > 256) throw supervisorError();
          const dirStat = await dir.stat();
          await check(dir, dirStat, true);
          directories.push({ path: group, metadata: metadata(dirStat) });
          const procsPath = `${descriptorPath(dir)}/cgroup.procs`;
          const procsStat = await lstat(procsPath);
          const file = await open(
            procsPath,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
          );
          let text: string;
          try {
            await check(file, procsStat, false);
            const buffer = Buffer.alloc(16385);
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            if (offset > 16384) throw supervisorError();
            text = buffer.subarray(0, offset).toString("utf8");
            if (text && !/^(?:[1-9][0-9]*\n)+$/.test(text)) throw supervisorError();
            await check(file, await lstat(procsPath), false);
          } finally {
            await file.close();
          }
          for (const line of text.split("\n").filter(Boolean)) {
            const pid = Number(line);
            if (
              !Number.isSafeInteger(pid) ||
              allPids.has(pid) ||
              processes.length >= (init.role === "gateway" ? 32 : 512)
            )
              throw supervisorError();
            allPids.add(pid);
            const identity = await processIdentity(pid);
            if ((await processCgroup(pid)) !== group) throw supervisorError();
            processes.push({ ...identity, cgroup: group });
          }
          const iterator = await opendir(descriptorPath(dir), { bufferSize: 16 });
          try {
            for (;;) {
              const entry = await iterator.read();
              if (!entry) break;
              if (
                ++entries > 256 ||
                !/^[A-Za-z0-9_.:@-]+$/.test(entry.name) ||
                [".", ".."].includes(entry.name)
              )
                throw supervisorError();
              const childPath = `${descriptorPath(dir)}/${entry.name}`;
              const stat = await lstat(childPath);
              if (stat.isFile()) continue; // Fixed cgroupfs control files, never read arbitrary contents.
              if (!stat.isDirectory()) throw supervisorError();
              const child = await open(childPath, flags);
              try {
                await check(child, stat, true);
                await scan(child, `${group}/${entry.name}`, depth + 1);
                await check(child, await lstat(childPath), true);
              } finally {
                await child.close();
              }
            }
          } finally {
            await iterator.close();
          }
          await check(dir, dirStat, true);
        };
        await scan(directory, path, 0);
        if (!processes.some((p) => p.pid === init.pid)) throw supervisorError();
        for (const ancestor of ancestors)
          if (
            !same(
              metadata(await lstat(`${descriptorPath(ancestor.parent)}/${ancestor.name}`)),
              metadata(ancestor.stat)
            )
          )
            throw supervisorError();
        pair.push({
          role: init.role,
          id: init.id,
          path,
          directories: directories.sort((a, b) => a.path.localeCompare(b.path)),
          processes: processes.sort((a, b) => a.pid - b.pid)
        });
      } finally {
        for (const file of handles.reverse()) await file.close();
      }
    }
    if (
      !same(before, await captureNamespaceAnchors()) ||
      !same(metadata(rootStat), metadata(await lstat(ROOT))) ||
      (await mountId(root)) !== rootMount
    )
      throw supervisorError();
    return { mountId: rootMount, root: metadata(rootStat), namespaces: before, pair };
  } finally {
    await root.close();
  }
}
