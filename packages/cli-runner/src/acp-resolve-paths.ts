import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { buildSetprivDropCommand } from "./setpriv.js";

/** Runs a program and returns its stdout. Injected so tests need no account switch. */
export type RunProgram = (command: string, args: readonly string[]) => Promise<string>;

export interface ResolveIdentity {
  readonly uid: number;
  readonly gid: number;
}

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

const execProgram: RunProgram = (command, args) =>
  new Promise((done, fail) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 5000 }, (err, stdout) =>
      err ? fail(err) : done(stdout)
    );
  });

/**
 * Follows symlinks for one path. A path that does not exist yet resolves its
 * deepest existing ancestor and keeps the rest, so a link in the middle of a
 * new path is still seen. Only a missing path is walked past; any other
 * failure (for example no permission) throws so the caller refuses.
 */
async function realLocation(absolute: string): Promise<string> {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !MISSING_CODES.has(code)) throw err;
      const parent = dirname(current);
      if (parent === current) return absolute;
      rest.push(current.slice(parent.length).replace(/^\/+/, ""));
      current = parent;
    }
  }
}

/**
 * Real absolute path for each input, resolved against the session folder.
 * With an identity, the lookup runs as that account, so it sees exactly what
 * the agent can reach. A failed lookup throws.
 */
export async function resolveRealPaths(
  cwd: string,
  paths: readonly string[],
  identity: ResolveIdentity | null = null,
  run: RunProgram = execProgram
): Promise<string[]> {
  const absolutes = paths.map((target) => resolve(cwd, target));
  if (identity === null) return Promise.all(absolutes.map(realLocation));
  if (absolutes.length === 0) return [];
  const { command, args } = buildSetprivDropCommand(
    "realpath",
    ["-m", "-z", "--", ...absolutes],
    identity
  );
  const parts = (await run(command, args)).split("\0");
  if (parts.pop() !== "" || parts.length !== absolutes.length) {
    throw new Error("path lookup returned an unexpected answer");
  }
  return parts;
}
