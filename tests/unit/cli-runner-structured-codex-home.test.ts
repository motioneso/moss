/**
 * #2687 — a background Codex call runs as its owner and must also run in the owner's home. Codex
 * finds its login through HOME, so the runner's own home there means no login and a refused read.
 */
import type * as ChildProcessModule from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      spawned.push({ command, args, env: opts.env });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true
      });
      setImmediate(() => child.emit("close", 0));
      return child;
    }
  };
});

const { createOwnerIo, preparePerUserStructuredLaunch } =
  await import("../../packages/cli-runner/src/per-user-structured.js");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "structured-codex-home-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  spawned.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("per-user background Codex call", () => {
  it("runs its commands with the owner's home as HOME", async () => {
    const homeBase = tempDir();
    const agentHome = join(homeBase, "agents", "user-b");
    const launch = await preparePerUserStructuredLaunch(
      {
        homeBase,
        neutralBase: tempDir(),
        applyOwnership: async () => undefined,
        prepareOwnerHome: async () => agentHome,
        codexHomeAccess: () => ({ read: async () => null, write: async () => undefined })
      },
      "structured-home",
      { provider: "openai-compatible", userId: "user-b", needsStructuredOutput: true }
    );
    spawned.length = 0;
    await launch.io.run("bash", ["-lc", "codex exec --json"], { cwd: launch.neutralDir });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env.HOME).toBe(agentHome);
    expect(spawned[0]!.env.CODEX_HOME).toBe(join(agentHome, ".codex"));
  });
});

describe("bounded owner io", () => {
  // The runner may not signal another account's process, so the owner's side enforces the deadline.
  it("runs a bounded command under a deadline the owner enforces", async () => {
    const io = createOwnerIo(
      { uid: 100002, gid: 100002 },
      {
        limits: { timeoutMs: 5_000, maxOutputBytes: 1024 }
      }
    );
    await io.run("node", ["-e", "0"]);
    expect(spawned).toHaveLength(1);
    const args = spawned[0]!.args;
    const afterSwitch = args.slice(args.indexOf("--") + 1);
    expect(afterSwitch.slice(0, 5)).toEqual(["timeout", "-s", "KILL", "5", "node"]);
  });

  it("leaves an unbounded command as it is", async () => {
    const io = createOwnerIo({ uid: 100002, gid: 100002 });
    await io.run("node", ["-e", "0"]);
    const args = spawned[0]!.args;
    expect(args.slice(args.indexOf("--") + 1)[0]).toBe("node");
  });
});
