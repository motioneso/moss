import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

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

// Symlink chains longer than this are treated as an escape/cycle attempt rather than resolved
// further — bounds the loop in canonicalizeAsFarAsExists against a self-referential dangling
// symlink (e.g. a -> "S/../a" where S is a symlink), which has no fixed point to converge on.
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolves targetPath the way the kernel does: symlinks are followed component-by-component, and
 * ".." is only ever applied to the already-fully-resolved prefix built up so far — never to a
 * symlink's own literal path segment. This matters because a lexical join+normalize of a readlink
 * result (e.g. resolve(dirname(current), linkTarget)) collapses ".." against whatever text
 * precedes it, even when that text names a symlinked directory the kernel would have resolved
 * elsewhere first — silently producing a different (and potentially in-root-looking) path than
 * the one the actual syscall will use.
 *
 * Stops as soon as it reaches a path component that does not exist and appends the remaining
 * (nonexistent) suffix literally, since a component that does not exist cannot be a symlink
 * needing further resolution — this lets targetPath be a not-yet-created file.
 */
async function canonicalizeAsFarAsExists(targetPath: string): Promise<string> {
  let parts = (isAbsolute(targetPath) ? targetPath : resolve(targetPath))
    .split(sep)
    .filter(Boolean);
  let resolved: string = sep;
  let hops = 0;
  let i = 0;

  while (i < parts.length) {
    const part = parts[i];
    if (part === ".") {
      i++;
      continue;
    }
    if (part === "..") {
      resolved = resolved === sep ? sep : dirname(resolved);
      i++;
      continue;
    }

    const candidate = resolved === sep ? sep + part : resolved + sep + part;
    let stat;
    try {
      stat = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // candidate (and therefore everything after it) does not exist. Append the remainder
      // literally — components that don't exist cannot be symlinks that need resolving.
      let tail = candidate;
      for (let j = i + 1; j < parts.length; j++) {
        const rest = parts[j];
        if (rest === ".") continue;
        tail = rest === ".." ? dirname(tail) : tail + sep + rest;
      }
      return tail;
    }

    if (stat.isSymbolicLink()) {
      hops++;
      if (hops > MAX_SYMLINK_HOPS) {
        throw new NotesPathError(
          `Too many symlink hops resolving "${targetPath}"`,
          "PATH_NOT_IN_ROOT"
        );
      }
      const linkTarget = await readlink(candidate);
      const rest = parts.slice(i + 1);
      const linkParts = linkTarget.split(sep).filter(Boolean);
      // The already-resolved prefix has no symlinks in it by construction, so re-walking it
      // (for a relative link target) can never add another hop or diverge from `resolved`.
      const prefixParts = isAbsolute(linkTarget) ? [] : resolved.split(sep).filter(Boolean);
      parts = [...prefixParts, ...linkParts, ...rest];
      resolved = sep;
      i = 0;
      continue;
    }

    resolved = candidate;
    i++;
  }

  return resolved;
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
 */
export async function recheckWithinRoot(resolvedRoot: string, targetPath: string): Promise<void> {
  const resolved = await canonicalizeAsFarAsExists(targetPath);
  assertWithinRoot(resolvedRoot, resolved);
}
