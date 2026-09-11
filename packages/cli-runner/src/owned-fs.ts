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

import { spawn } from "node:child_process";
import { O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_TRUNC, O_WRONLY } from "node:constants";
import { lstat, mkdir, open, rm, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { buildSetprivDropCommand } from "./setpriv.js";

/**
 * Hands an open handle to its owner. Injected so tests can prove the launch
 * refusal on a real, deliberately unreachable id (no privilege needed) while
 * still exercising the routing tests below it without needing real root.
 * Production always uses the default, which really calls chown.
 */
export type OwnershipApplier = (handle: FileHandle, uid: number, gid: number) => Promise<void>;

const defaultApplyOwnership: OwnershipApplier = (handle, uid, gid) => handle.chown(uid, gid);

/**
 * One folder level made by prepareOwnedPathWithOwnership: enough to hand it
 * over later, deepest first, without redoing the lstat/mkdir/verify work and
 * without losing track of which levels this call actually created (task 5b,
 * Astra-Reviewer finding 2, 2026-09-08 — the old single-pass code chowned
 * each level as soon as it made it, so a file written into a level after
 * that point landed in a folder the launcher itself could no longer enter).
 */
export interface OwnedPathLevel {
  readonly path: string;
  readonly createdHere: boolean;
  readonly ownedHere: boolean;
}

/**
 * Build every level of a folder path under the runner base without ever
 * following a link and without handing any of it over yet. Returns the full
 * path. Pair with handOverOwnedPath once every file this launch needs inside
 * the tree has been written.
 */
export async function prepareOwnedPath(
  baseDir: string,
  key: string,
  ...segments: string[]
): Promise<string> {
  return (await prepareOwnedPathWithOwnership(baseDir, key, segments)).path;
}

/**
 * Same as prepareOwnedPath, but returns the per-level record handOverOwnedPath
 * needs, and lets the caller mark a leading run of segments as shared parents
 * that are never handed over.
 *
 * `sharedPrefixCount` marks how many of the leading segments are shared
 * parents rather than one person's own folder (task 5b, Astra-Reviewer
 * finding 3, 2026-09-08): those levels stay owned by the caller (this
 * process), mode 0711 pass-through, so the launcher can keep creating
 * siblings under them for other people.
 */
export async function prepareOwnedPathWithOwnership(
  baseDir: string,
  key: string,
  segments: readonly string[],
  sharedPrefixCount = 0
): Promise<{ path: string; levels: OwnedPathLevel[] }> {
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
  const levels: OwnedPathLevel[] = [];
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const ownedHere = index >= sharedPrefixCount;
    const createdHere = await prepareOwnedDir(key, current, ownedHere);
    levels.push({ path: current, createdHere, ownedHere });
  }
  return { path: current, levels };
}

/**
 * Hand every owned-here level over to its owner, deepest first, stopping and
 * cleaning up at the first failure (task 5b, Astra-Reviewer finding 2,
 * 2026-09-08). Call only once every file this launch writes into the tree
 * has been written by writeOwnedFile — that write needs the launcher's own
 * access, which a level already handed over would refuse it.
 */
export async function handOverOwnedPath(
  key: string,
  levels: readonly OwnedPathLevel[],
  uid: number,
  gid: number,
  applyOwnership: OwnershipApplier = defaultApplyOwnership
): Promise<void> {
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const level = levels[index] as OwnedPathLevel;
    if (!level.ownedHere) continue;
    const handle = await open(level.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      await applyOwnership(handle, uid, gid);
    } catch (error) {
      if (level.createdHere) {
        await rm(level.path, { force: true, recursive: true }).catch(() => undefined);
      }
      throw new Error(
        `AcpHost: ${key} could not hand the project folder to its owner, launch refused: ${(error as Error).message}`,
        { cause: error }
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

/**
 * Write content to path without ever following a link, without handing it
 * over yet. A planted link is removed first, and the file is opened with
 * O_NOFOLLOW. Returns whether this call created the file fresh (false if it
 * already existed) — pass that to handOverOwnedFile so a failed handover
 * only removes what this call made (task 5b, Astra-Reviewer finding 1,
 * 2026-09-08).
 */
export async function writeOwnedFile(key: string, path: string, content: string): Promise<boolean> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
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
  } finally {
    await handle.close().catch(() => undefined);
  }
  return !preexisting;
}

/**
 * Hand a file writeOwnedFile made over to its owner. Call only after every
 * write this launch needs is done — a level or file already handed over
 * refuses the launcher's own further writes (task 5b, Astra-Reviewer
 * finding 2, 2026-09-08).
 */
export async function handOverOwnedFile(
  key: string,
  path: string,
  createdHere: boolean,
  uid: number,
  gid: number,
  applyOwnership: OwnershipApplier = defaultApplyOwnership
): Promise<void> {
  const handle = await open(path, O_WRONLY | O_NOFOLLOW);
  try {
    await applyOwnership(handle, uid, gid);
  } catch (error) {
    if (createdHere) await unlink(path).catch(() => undefined);
    throw new Error(
      `AcpHost: ${key} could not hand ${path} to its owner, launch refused: ${(error as Error).message}`,
      { cause: error }
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Make one folder level real without ever following a link, without handing
 * it over yet. The parent level must already be secured (see
 * prepareOwnedPath): this creates only this level, so a link above it cannot
 * redirect the creation. Returns whether this call created it fresh.
 */
async function prepareOwnedDir(key: string, path: string, ownedHere: boolean): Promise<boolean> {
  const first = await lstat(path).catch(() => null);
  if (first && first.isSymbolicLink()) await unlink(path);
  // Only clean up on a later failed handover what this call actually made: a
  // folder that already existed (this launch merely reused it) must survive
  // untouched (task 5b, Astra-Reviewer finding 1, 2026-09-08 — the old
  // cleanup deleted a whole pre-existing home).
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
    // no chown, ever (task 5b, Astra-Reviewer finding 3, 2026-09-08).
    try {
      await handle.chmod(ownedHere ? 0o700 : 0o711);
    } catch (error) {
      console.warn(`[acp-host] ${key} could not lock ${path}: ${(error as Error).message}`);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return createdHere;
}

/**
 * Ensure one person's top-level folder exists and is owned by exactly their
 * slot, without ever opening it: once a top level is someone else's the
 * launcher cannot enter it, and must not try (task 5b, Astra-Reviewer
 * round-four finding, 2026-09-08 — a second launch for the same person was
 * refused reopening their own now owner-only home). Created only when
 * absent, then handed over at once while still empty; when one already
 * exists its ownership is checked from the kernel's record alone (a real
 * folder, not a link, owned by exactly this slot) and the launch refuses if
 * anyone else owns it. Everything below this level is the caller's job, done
 * by a preparation step running as the person, never by the launcher.
 */
export async function ensureOwnedTopLevel(
  key: string,
  parentDir: string,
  segment: string,
  uid: number,
  gid: number,
  applyOwnership: OwnershipApplier = defaultApplyOwnership
): Promise<{ path: string; createdHere: boolean }> {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error("AcpHost: refusing an unsafe folder name");
  }
  const path = join(parentDir, segment);
  const existing = await lstat(path).catch(() => null);
  if (existing) {
    if (!existing.isDirectory()) {
      throw new Error(`AcpHost: ${key} top level ${path} is not a real folder, launch refused`);
    }
    if (existing.uid !== uid || existing.gid !== gid) {
      throw new Error(
        `AcpHost: ${key} top level ${path} is owned by uid=${existing.uid} gid=${existing.gid}, ` +
          `not this slot (uid=${uid} gid=${gid}), launch refused`
      );
    }
    return { path, createdHere: false };
  }
  const createdHere = await prepareOwnedDir(key, path, true);
  await handOverOwnedPath(key, [{ path, createdHere, ownedHere: true }], uid, gid, applyOwnership);
  return { path, createdHere };
}

/**
 * Delete an owned working folder as its owning account, the same
 * setpriv-drop path a kill signal uses to stop the owning process. Node's
 * own binary does the removal (`-e`, an fs call) so no external `rm`
 * program needs to exist in the image. The folder path travels through an
 * env var, never interpolated into a script string.
 */
export async function purgeOwnedPath(
  path: string,
  identity: { readonly uid: number; readonly gid: number } | null
): Promise<void> {
  if (!identity) {
    await rm(path, { recursive: true, force: true });
    return;
  }
  const { command, args } = buildSetprivDropCommand(
    process.execPath,
    ["-e", "require('node:fs').rmSync(process.env.ACP_PURGE_DIR,{recursive:true,force:true})"],
    identity
  );
  await new Promise<void>((resolve, reject) => {
    const purger = spawn(command, args, {
      stdio: "ignore",
      env: { ...buildSanitizedCliEnv(process.env), ACP_PURGE_DIR: path }
    });
    purger.once("error", reject);
    purger.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`purge for ${path} exited with code ${String(code)}`));
    });
  });
}
