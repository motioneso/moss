import { execFile } from "node:child_process";

import { buildSetprivDropCommand } from "./setpriv.js";

/** Runs a program and returns its stdout. Injected so tests need no account switch. */
export type RunProgram = (command: string, args: readonly string[]) => Promise<string>;

export interface ResolveIdentity {
  readonly uid: number;
  readonly gid: number;
}

/**
 * Walks each path one piece at a time the way the kernel does, so a link
 * followed before ".." sends ".." to the link's target. A missing piece ends
 * the walk and the rest is kept as written. Any other failure (no permission,
 * link loop) exits non-zero so the caller refuses. Runs in its own process so
 * it can run as the session account.
 */
const WALKER = `
const fs = require("node:fs");
const path = require("node:path");
function walk(input) {
  const todo = input.split("/").filter(Boolean).reverse();
  let cur = "/";
  let links = 0;
  let missing = false;
  while (todo.length) {
    const piece = todo.pop();
    if (piece === ".") continue;
    if (missing) { cur = path.join(cur, piece); continue; }
    if (piece === "..") { cur = path.dirname(cur); continue; }
    const next = path.join(cur, piece);
    let stat;
    try { stat = fs.lstatSync(next); } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") { missing = true; cur = next; continue; }
      throw err;
    }
    if (!stat.isSymbolicLink()) { cur = next; continue; }
    if (++links > 40) throw new Error("too many links");
    const target = fs.readlinkSync(next);
    if (target.startsWith("/")) cur = "/";
    todo.push(...target.split("/").filter(Boolean).reverse());
  }
  return cur;
}
process.stdout.write(process.argv.slice(1).map((p) => walk(p) + "\\0").join(""));
`;

const execProgram: RunProgram = (command, args) =>
  new Promise((done, fail) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 5000 }, (err, stdout) =>
      err ? fail(err) : done(stdout)
    );
  });

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
  if (paths.length === 0) return [];
  const inputs = paths.map((target) => (target.startsWith("/") ? target : `${cwd}/${target}`));
  const walkerArgs = ["-e", WALKER, "--", ...inputs];
  const { command, args } =
    identity === null
      ? { command: process.execPath, args: walkerArgs }
      : buildSetprivDropCommand(process.execPath, walkerArgs, identity);
  const parts = (await run(command, args)).split("\0");
  if (parts.pop() !== "" || parts.length !== inputs.length) {
    throw new Error("path lookup returned an unexpected answer");
  }
  return parts;
}
