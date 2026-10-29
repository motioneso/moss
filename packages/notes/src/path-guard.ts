import { normalize } from "node:path";

import { canonicalizeAsFarAsExists, VaultPathError } from "@moss/vault";

export class NotesPathError extends Error {
  constructor(
    message: string,
    readonly code: "PATH_NOT_IN_ROOT"
  ) {
    super(message);
    this.name = "NotesPathError";
  }
}

/**
 * Asserts that absoluteFilePath is within resolvedRoot (already fs.realpath'd).
 * Throws NotesPathError if the path escapes the root.
 */
export function assertWithinRoot(resolvedRoot: string, absoluteFilePath: string): void {
  const normalizedFile = normalize(absoluteFilePath);
  const rootPrefix = resolvedRoot.endsWith("/") ? resolvedRoot : resolvedRoot + "/";
  if (normalizedFile !== resolvedRoot && !normalizedFile.startsWith(rootPrefix)) {
    throw new NotesPathError(
      `Path "${absoluteFilePath}" is not within allowed root "${resolvedRoot}"`,
      "PATH_NOT_IN_ROOT"
    );
  }
}

/**
 * TOCTOU narrow (defense-in-depth, not a full close): re-resolves targetPath immediately before
 * a filesystem I/O call and re-asserts containment. targetPath may not exist yet (e.g. a
 * not-yet-created file) — see canonicalizeAsFarAsExists for how that and symlink hops are
 * handled. An attacker who swaps an ancestor directory (or the target itself) for a symlink
 * *before* this recheck runs is caught, because the swap is visible to this resolution. A swap
 * landing in the residual window between this recheck returning and the actual syscall is not —
 * that window can only be closed with O_NOFOLLOW / dirfd-relative I/O, which this guard does not
 * use.
 *
 * Acknowledged residual (out of scope): this resolves symlinks, not hardlinks or bind mounts. A
 * hardlink inside resolvedRoot pointing at inode content outside it, or a directory bind-mounted
 * over an in-root path at the OS level, both present as an ordinary file/directory to lstat and
 * pass containment. Both require filesystem-level access this guard is not scoped to defend
 * against (an attacker who can create either already has host access broader than this boundary).
 */
export async function recheckWithinRoot(resolvedRoot: string, targetPath: string): Promise<void> {
  try {
    const resolved = await canonicalizeAsFarAsExists(targetPath);
    assertWithinRoot(resolvedRoot, resolved);
  } catch (error) {
    if (error instanceof VaultPathError) {
      throw new NotesPathError(error.message, "PATH_NOT_IN_ROOT");
    }
    throw error;
  }
}
