import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { VaultPathError } from "./vault-path.js";

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
export async function canonicalizeAsFarAsExists(targetPath: string): Promise<string> {
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
        throw new VaultPathError(targetPath);
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
