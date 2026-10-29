import { constants } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { createConnection } from "node:net";
import type { RootIdentity } from "../computer-host/config.js";
import { ComputerDocker } from "../computer-host/docker.js";
import { assertRoot, descriptorPath, openRoot, mountId } from "../computer-watchdog/linux-files.js";
import { checkMossReadiness } from "../computer-watchdog/observe.js";
import { processIdentity, sha256, supervisorError } from "../computer-watchdog/trust.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";
import type { ClosureDeployment } from "./config.js";
import type { ClosureRecords } from "./records.js";

/** Conservative: even a reused PID, zombie, or unrelated surviving group refuses closure. */
export async function assertProcessesAbsent(
  identities: readonly WatchdogProcessIdentity[]
): Promise<void> {
  const own = await processIdentity(process.pid);
  for (const identity of identities) {
    if (identity.pid === own.pid || identity.processGroupId === own.processGroupId)
      throw supervisorError();
    try {
      await lstat(`/proc/${identity.pid}`);
      throw supervisorError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw supervisorError();
    }
    try {
      process.kill(-identity.processGroupId, 0);
      throw supervisorError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw supervisorError();
    }
  }
}

/** Connect only. Never sends application bytes or treats timeout/permission errors as closure. */
export function probeClosedSocket(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      if (closed) resolve();
      else reject(supervisorError());
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(["ENOENT", "ECONNREFUSED"].includes(error.code ?? ""))
    );
  });
}
interface Entry {
  name: string;
  dev: number;
  ino: number;
  mode: number;
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Linux O_PATH inspects sockets and regular files without opening their content.
const pathFlags = 0x200000 | constants.O_NOFOLLOW;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function assertEntryMount(
  path: string,
  expected: string,
  entry: Pick<Entry, "dev" | "ino" | "mode">
): Promise<void> {
  const file = await open(path, pathFlags);
  try {
    const opened = await file.stat();
    if (
      (await mountId(file)) !== expected ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.mode !== entry.mode
    )
      throw supervisorError();
  } finally {
    await file.close();
  }
}

/** Enumerate and probe underlying bind sockets, not merely their published aliases. */
export async function inspectClosureEndpoints(
  roots: readonly RootIdentity[],
  fixed: readonly string[][]
): Promise<string> {
  let count = 0;
  const observed: unknown[] = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const directory = await openRoot(root);
    let rootMount = "";
    const scan = async (dir: FileHandle, depth: number, prefix: string): Promise<Entry[]> => {
      if (depth > 3) throw supervisorError();
      const iterator = await opendir(descriptorPath(dir), { bufferSize: 16 });
      const entries: Entry[] = [];
      try {
        for (;;) {
          const entry = await iterator.read();
          if (!entry) break;
          if (++count > 256 || /[\uFFFD/\0]/u.test(entry.name) || [".", ".."].includes(entry.name))
            throw supervisorError();
          const path = `${descriptorPath(dir)}/${entry.name}`;
          const stat = await lstat(path);
          if (stat.dev !== root.dev || !(stat.isDirectory() || stat.isFile() || stat.isSocket()))
            throw supervisorError();
          await assertEntryMount(path, rootMount, stat);
          entries.push({
            name: prefix + entry.name,
            dev: stat.dev,
            ino: stat.ino,
            mode: stat.mode
          });
          if (stat.isSocket()) await probeClosedSocket(path);
          if (stat.isDirectory()) {
            const child = await open(path, directoryFlags);
            try {
              const opened = await child.stat();
              if (
                opened.dev !== stat.dev ||
                opened.ino !== stat.ino ||
                opened.mode !== stat.mode ||
                (await mountId(child)) !== rootMount
              )
                throw supervisorError();
              entries.push(...(await scan(child, depth + 1, prefix + entry.name + "/")));
            } finally {
              await child.close();
            }
          }
          const after = await lstat(path);
          await assertEntryMount(path, rootMount, after);
          if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode)
            throw supervisorError();
        }
      } finally {
        await iterator.close();
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    };
    try {
      rootMount = await mountId(directory);
      const before = await scan(directory, 0, "");
      for (const name of fixed[i] ?? [])
        await probeClosedSocket(`${descriptorPath(directory)}/${name}`);
      // A separate enumeration catches additions/removals while native probes awaited.
      const previousCount = count;
      count = 0;
      const after = await scan(directory, 0, "");
      count = previousCount;
      if (!equal(before, after)) throw supervisorError();
      await assertRoot(root);
      observed.push({ root, mountId: rootMount, entries: after });
    } finally {
      await directory.close();
    }
  }
  return sha256(Buffer.from(JSON.stringify(observed)));
}

export async function observeClosure(
  deployment: ClosureDeployment,
  records: ClosureRecords,
  ready = checkMossReadiness
): Promise<string> {
  const { supervisor, processes } = deployment.configuration;
  if ((await new ComputerDocker(supervisor.host).inventory(records.state.resources)).length !== 0)
    throw supervisorError();
  await assertProcessesAbsent([
    supervisor.runner,
    ...Object.values(processes),
    ...records.collectors
  ]);
  const paths = [
    supervisor.host.controlDir,
    supervisor.host.gatewayDir,
    supervisor.host.guestSocketDir
  ];
  const roots = paths.map((path) => {
    const root = deployment.roots.find((root) => root.path === path);
    if (!root) throw supervisorError();
    return root;
  });
  const hash = await inspectClosureEndpoints(roots, [
    ["host.sock"],
    ["gateway.sock", "lifetime.sock"],
    ["viewer.sock"]
  ]);
  await ready(supervisor.readyUrl);
  return hash;
}
