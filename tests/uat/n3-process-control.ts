import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync } from "node:fs";

function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
export function startChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  log: string,
  detached = false
): ChildProcess {
  const fd = openSync(log, "wx", 0o600);
  let child: ChildProcess | undefined;
  try {
    child = spawn(args[0]!, args.slice(1), { env, stdio: ["ignore", fd, fd], detached });
    // No post-spawn exception may lose the child. Unknown birth stays uncertain.
    try {
      if (child.pid) births.set(child, processIdentity(child.pid));
    } catch {
      /* Missing birth remains uncertain. */
    }
    return child;
  } finally {
    try {
      closeSync(fd);
    } catch {
      if (child) births.delete(child); // Preserve ownership, mark closure uncertain.
    }
  }
}
export function settled(child: ChildProcess): Promise<number> {
  return new Promise((resolveResult) => {
    child.once("error", () => resolveResult(1));
    child.once("close", (code) => resolveResult(code ?? 1));
  });
}
export interface ProcessIdentity {
  pid: number;
  start: string;
  group: number;
  session: number;
}
const births = new WeakMap<ChildProcess, ProcessIdentity | undefined>();
export function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, start: fields[19]!, group: Number(fields[2]), session: Number(fields[3]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export function validateProcess(
  expected: ProcessIdentity | undefined,
  actual: ProcessIdentity
): void {
  check(
    expected && JSON.stringify(expected) === JSON.stringify(actual),
    "process identity changed"
  );
}
export function signalOwned(child: ChildProcess, signal: NodeJS.Signals, group = false): void {
  if (!child.pid) return;
  const current = processIdentity(child.pid);
  if (!current) return;
  validateProcess(births.get(child), current); // Revalidate before EVERY TERM/KILL.
  if (group) check(current.group === child.pid && current.session === child.pid, "unowned group");
  try {
    process.kill(group ? -child.pid : child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
export function groupClosed(child: ChildProcess): boolean {
  if (!child.pid) return true;
  if (!births.get(child)) return false;
  return !readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .some((name) => processIdentity(Number(name))?.group === child.pid);
}
