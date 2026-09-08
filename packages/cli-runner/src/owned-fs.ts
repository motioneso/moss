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
import { lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { opencodeDenyPermissionKeys } from "@moss/acp";

/**
 * Hands an open handle to its owner. Injected so tests can prove the launch
 * refusal on a real, deliberately unreachable id (no privilege needed) while
 * still exercising the routing tests below it without needing real root.
 * Production always uses the default, which really calls chown.
 */
export type OwnershipApplier = (handle: FileHandle, uid: number, gid: number) => Promise<void>;

const defaultApplyOwnership: OwnershipApplier = (handle, uid, gid) => handle.chown(uid, gid);

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
  return prepareOwnedPathWithOwnership(baseDir, key, uid, gid, segments);
}

/**
 * Same as prepareOwnedPath, but lets the caller swap in how a folder is
 * handed to its owner. AcpHost uses this so its tests can prove the routing
 * logic without needing real chown privileges, while still proving the real
 * failure-and-cleanup behavior separately against a genuinely unreachable id.
 *
 * `sharedPrefixCount` marks how many of the leading segments are shared
 * parents rather than one person's own folder (task 5b, Astra-Reviewer
 * finding 3, 2026-09-08): those levels stay owned by the caller (this
 * process), mode 0711 pass-through, so the launcher can keep creating
 * siblings under them for other people. Ownership only hands over starting
 * at the first segment past that prefix.
 */
export async function prepareOwnedPathWithOwnership(
  baseDir: string,
  key: string,
  uid: number | undefined,
  gid: number | undefined,
  segments: readonly string[],
  applyOwnership: OwnershipApplier = defaultApplyOwnership,
  sharedPrefixCount = 0
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
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    await prepareOwnedDir(key, current, uid, gid, applyOwnership, index >= sharedPrefixCount);
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
  gid: number | undefined,
  applyOwnership: OwnershipApplier = defaultApplyOwnership
): Promise<void> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
  // A file already there before this call was not this call's to remove on
  // failure — only a fresh write this call made is (task 5b, Astra-Reviewer
  // finding 1, 2026-09-08).
  const preexisting = first !== null && !first.isSymbolicLink();
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
        await applyOwnership(handle, uid, gid);
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (!preexisting) {
          await unlink(path).catch(() => undefined);
        }
        throw new Error(
          `AcpHost: ${key} could not hand ${path} to its owner, launch refused: ${(error as Error).message}`,
          { cause: error }
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
  gid: number | undefined,
  applyOwnership: OwnershipApplier = defaultApplyOwnership,
  ownedHere = true
): Promise<void> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
  // Only clean up on failure what this call actually made: a folder that
  // already existed (this launch merely reused it) must survive a failed
  // handover untouched (task 5b, Astra-Reviewer finding 1, 2026-09-08 — the
  // old cleanup deleted a whole pre-existing home).
  let createdHere = false;
  await mkdir(path).then(
    () => {
      createdHere = true;
    },
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  );
  const verified = await lstat(path).catch(() => null);
  if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
    throw new Error("AcpHost: session folder is not a folder");
  }
  const handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    // A shared parent stays owned by the launcher itself, pass-through only:
    // no chown, so the launcher can keep creating other people's sibling
    // folders underneath it (task 5b, Astra-Reviewer finding 3, 2026-09-08).
    if (!ownedHere) {
      try {
        await handle.chmod(0o711);
      } catch (error) {
        console.warn(
          `[acp-host] ${key} could not lock the shared folder pass-through: ${(error as Error).message}`
        );
      }
      return;
    }
    try {
      await handle.chmod(0o700);
    } catch (error) {
      console.warn(
        `[acp-host] ${key} could not lock the project folder owner-only: ${(error as Error).message}`
      );
    }
    if (uid !== undefined && gid !== undefined) {
      try {
        await applyOwnership(handle, uid, gid);
      } catch (error) {
        await handle.close().catch(() => undefined);
        if (createdHere) {
          await rm(path, { force: true, recursive: true }).catch(() => undefined);
        }
        throw new Error(
          `AcpHost: ${key} could not hand the project folder to its owner, launch refused: ${(error as Error).message}`,
          { cause: error }
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * OpenCode chat deny file in the agent home: shell and file edits denied from
 * the tool table's chat column. Merges into an existing config, keeping the rest.
 */
export async function writeOpencodeChatDenyFile(
  agentHome: string,
  userId: string,
  uid: number | undefined,
  gid: number | undefined,
  applyOwnership: OwnershipApplier = defaultApplyOwnership
): Promise<void> {
  const dir = await prepareOwnedPathWithOwnership(
    agentHome,
    userId,
    uid,
    gid,
    [".config", "opencode"],
    applyOwnership
  );
  const path = join(dir, "opencode.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // Absent or broken config: start fresh, nothing to keep.
  }
  const prior = config.permission;
  const permission: Record<string, unknown> =
    prior && typeof prior === "object" && !Array.isArray(prior) ? { ...prior } : {};
  for (const key of opencodeDenyPermissionKeys()) permission[key] = "deny";
  config.permission = permission;
  await writeOwnedFile(userId, path, JSON.stringify(config, null, 2), uid, gid, applyOwnership);
}
