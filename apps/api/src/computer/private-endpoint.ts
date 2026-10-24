import { chmod, link, lstat, mkdtemp, realpath, rmdir, unlink } from "node:fs/promises";
import type { Server } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

export async function assertComputerPrivateParent(path: string): Promise<void> {
  const uid = process.getuid!();
  const parent = dirname(path);
  if (!isAbsolute(path) || parent === path || (await realpath(parent)) !== parent)
    throw new Error("Computer IPC unavailable");
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700)
    throw new Error("Computer IPC unavailable");
  for (let ancestor = dirname(parent); ; ancestor = dirname(ancestor)) {
    const s = await lstat(ancestor);
    if (
      ![0, uid].includes(s.uid) ||
      ((s.mode & 0o022) !== 0 && !(s.uid === 0 && (s.mode & 0o1000) !== 0))
    )
      throw new Error("Computer IPC unavailable");
    if (dirname(ancestor) === ancestor) break;
  }
}

/** Node owns only its private bind path; publish an exclusive alias with explicit owned cleanup. */
export async function publishComputerSocket(server: Server, socketPath: string, prefix: string) {
  await assertComputerPrivateParent(socketPath);
  let directory: string | undefined;
  let published = false;
  let identity: Awaited<ReturnType<typeof lstat>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (published) {
        const remaining = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (remaining && remaining.dev === identity?.dev && remaining.ino === identity.ino)
          await unlink(socketPath);
      }
      if (directory) await rmdir(directory);
    })());
  try {
    directory = await mkdtemp(join(dirname(socketPath), prefix));
    const bindPath = join(directory, "s");
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(bindPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(bindPath, 0o600);
    identity = await lstat(bindPath);
    await link(bindPath, socketPath);
    published = true;
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
