import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Follows symlinks for one path. A path that does not exist yet resolves its
 * deepest existing ancestor and keeps the rest, so a link in the middle of a
 * new path is still seen.
 */
async function realLocation(absolute: string): Promise<string> {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(current.slice(parent.length).replace(/^\/+/, ""));
      current = parent;
    }
  }
}

/** Real absolute path for each input, resolved against the session folder. */
export async function resolveRealPaths(cwd: string, paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((target) => realLocation(resolve(cwd, target))));
}
