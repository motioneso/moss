/**
 * Link-safe filesystem setup for runner-owned folders and files.
 *
 * A command that ran here earlier can plant a link at any level of a folder
 * path or at a file's name, so every level is secured on its own: a planted
 * link is removed, the real folder is created and verified before the next
 * level builds on it, and files are written through handles opened with
 * O_NOFOLLOW, which refuse to resolve to anything but the file itself. A link
 * re-planted in between fails closed instead of writing through. Only the
 * runner base itself is trusted; the runner creates it at startup.
 */

import { O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_TRUNC, O_WRONLY } from "node:constants";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Build every level of a folder path under the runner base without ever
 * following a link. Returns the full path.
 */
export async function prepareOwnedPath(
  baseDir: string,
  key: string,
  uid: number | undefined,
  gid: number | undefined,
  ...segments: string[]
): Promise<string> {
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("..") ||
      segment.includes("\0")
    ) {
      throw new Error("AcpHost: refusing an unsafe folder name");
    }
  }
  let current = baseDir;
  for (const segment of segments) {
    current = join(current, segment);
    await prepareOwnedDir(key, current, uid, gid);
  }
  return current;
}

/**
 * Write content to path without ever following a link. A planted link is
 * removed first, and the file is opened with O_NOFOLLOW. Owner-only bits and
 * handover go through the open handle, so they can only land on this file. A
 * failure to lock or hand over is said out loud: silent best-effort is how
 * isolation ends up missing with nobody knowing.
 */
export async function writeOwnedFile(
  key: string,
  path: string,
  content: string,
  uid: number | undefined,
  gid: number | undefined
): Promise<void> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
  const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    try {
      await handle.chmod(0o700);
    } catch (error) {
      console.warn(
        `[acp-host] ${key} could not lock ${path} owner-only: ${(error as Error).message}`
      );
    }
    if (uid !== undefined && gid !== undefined) {
      try {
        await handle.chown(uid, gid);
      } catch (error) {
        console.warn(
          `[acp-host] ${key} could not hand ${path} to its owner: ${(error as Error).message}`
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Make one folder level real and owned without ever following a link. The
 * parent level must already be secured (see prepareOwnedPath): this creates
 * only this level, so a link above it cannot redirect the creation.
 */
async function prepareOwnedDir(
  key: string,
  path: string,
  uid: number | undefined,
  gid: number | undefined
): Promise<void> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
  await mkdir(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const verified = await lstat(path).catch(() => null);
  if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("AcpHost: session folder is not a folder");
  }
  const handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    try {
      await handle.chmod(0o700);
    } catch (error) {
      console.warn(
        `[acp-host] ${key} could not lock the project folder owner-only: ${(error as Error).message}`
      );
    }
    if (uid !== undefined && gid !== undefined) {
      try {
        await handle.chown(uid, gid);
      } catch (error) {
        console.warn(
          `[acp-host] ${key} could not hand the project folder to its owner: ${(error as Error).message}`
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}
