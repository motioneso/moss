import { realpath } from "node:fs/promises";
import { dirname, normalize } from "node:path";

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
 * TOCTOU close: re-resolves targetPath immediately before a filesystem I/O call and re-asserts
 * containment. targetPath may not exist yet (e.g. a not-yet-created file), so this walks upward
 * to the deepest existing ancestor and realpath's that instead — an attacker who swaps an
 * ancestor directory for a symlink between the last check and the syscall is caught here because
 * the swapped ancestor now realpath's outside resolvedRoot.
 */
export async function recheckWithinRoot(resolvedRoot: string, targetPath: string): Promise<void> {
  let current = targetPath;
  for (;;) {
    try {
      const resolved = await realpath(current);
      assertWithinRoot(resolvedRoot, resolved);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
