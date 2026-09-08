/**
 * AcpHost builds (#2369 slice 1 phase 3): one shell command runs in the
 * session project folder, output is capped at 256 KiB, and the deadline kills
 * the command while keeping whatever ran so far. Real processes throughout —
 * these prove the runner path, not a stub of it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ACP_EXEC_DEFAULT_TIMEOUT_MS,
  ACP_EXEC_OUTPUT_CAP_BYTES,
  MAX_EXECS_PER_SESSION,
  MAX_EXECS_TOTAL,
  AcpHost
} from "../../packages/cli-runner/src/acp-host.js";
import { providerTokenPath } from "../../packages/cli-runner/src/provider-token-store.js";

const KEY = "workshop:user:proj";
const PROJECT = "proj";

// This suite proves exec behavior, not real chown privilege — a plain test
// process has no CAP_CHOWN, so the one test that turns on per-user identity
// needs a no-op stand-in for handing a folder to its owner. The real
// throw-and-clean-up behavior is proved in cli-runner-owned-fs.test.ts.
const acceptOwnership = async (): Promise<void> => undefined;

function makeHost(dir: string) {
  return new AcpHost({ neutralBase: dir });
}

async function pollUntil(poll: () => { done: boolean }, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (poll().done) return;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the build");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A process's actual start time in system ticks, or null when it is gone. */
function procStartTime(pid: number): string | null {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = content.lastIndexOf(")");
    if (closing < 0) return null;
    const startTime = content.slice(closing + 2).split(" ")[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

async function pollUntilPidGone(pid: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      // No such process: it is gone. Anything else (like no permission to
      // signal it) means it is still there.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the build to die");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("AcpHost builds", () => {
  it("runs the command in the session project folder and returns its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "pwd; echo hello-build");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.exitCode).toBe(0);
      expect(final.timedOut).toBe(false);
      expect(final.truncated).toBe(false);
      expect(final.output).toContain("hello-build");
      // The working directory is the session project folder, not chosen by the caller.
      expect(final.output).toContain(join(dir, KEY, "acp", PROJECT));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the same folder an adapter spawn for that session uses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const { EventEmitter } = await import("node:events");
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write: () => undefined },
        kill: () => true
      }) as never;
      const homeBase = join(dir, "homes");
      mkdirSync(homeBase, { recursive: true });
      const host = new AcpHost({
        neutralBase: dir,
        homeBase,
        perUserUid: true,
        resolveAdapterTarget: () => ({ command: "/fake/node", args: ["/fake/adapter.js"] }),
        spawnChild: () => child,
        applyOwnership: acceptOwnership
      });
      const spawned = await host.spawn(KEY, PROJECT, "anthropic", "user-1", "chat");
      // Real shell runs need no account switch in tests (non-root cannot
      // setuid), so the build itself runs on a host without per-user
      // identity; the folder assertion is what this test owns.
      const execHost = new AcpHost({ neutralBase: dir });
      const { execId } = await execHost.execStart(KEY, PROJECT, "pwd");
      await pollUntil(execHost.execPoll.bind(execHost, KEY, execId));
      const final = execHost.execPoll(KEY, execId);
      expect(final.output.trim()).toBe(spawned.cwd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges stderr into the output so failing builds keep their error text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "echo out; echo err >&2; exit 3");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.exitCode).toBe(3);
      expect(final.output).toContain("out");
      expect(final.output).toContain("err");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills past the deadline and keeps whatever ran so far", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "echo started; sleep 30", 300);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.timedOut).toBe(true);
      expect(final.output).toContain("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a running build on kill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30");
      host.execKill(KEY, execId);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.timedOut).toBe(false);
      // Killing an unknown build is a no-op, never an error.
      expect(() => host.execKill(KEY, 999_999)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps output at 256 KiB and says it was cut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(
        KEY,
        PROJECT,
        "node -e \"process.stdout.write('x'.repeat(300 * 1024))\""
      );
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      expect(final.truncated).toBe(true);
      expect(Buffer.byteLength(final.output, "utf8")).toBeLessThanOrEqual(
        ACP_EXEC_OUTPUT_CAP_BYTES
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the build its own home, away from the login token and server secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    const homeBase = mkdtempSync(join(tmpdir(), "acp-homebase-"));
    // Even if these leaked into the runner process env, the child must not see them.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "server-side-oauth-token";
    process.env.JARVIS_TEST_SECRET_MARKER = "server-side-marker";
    process.env.JARVIS_CLI_HOME = homeBase;
    process.env.JARVIS_CLI_HOME_BASE = homeBase;
    try {
      const tokenPath = providerTokenPath(homeBase, "anthropic");
      mkdirSync(join(tokenPath, ".."), { recursive: true });
      writeFileSync(tokenPath, "test-login-token");
      const host = new AcpHost({ neutralBase: dir, homeBase });
      const { execId } = await host.execStart(
        KEY,
        PROJECT,
        "echo HOME=$HOME; echo OAUTH=$CLAUDE_CODE_OAUTH_TOKEN; " +
          "echo MARKER=$JARVIS_TEST_SECRET_MARKER; " +
          "env | grep -E 'JARVIS_CLI_HOME|MOSS_CLI_HOME' || echo NO_HOME_VARS; " +
          "cat $HOME/.jarvis/cli-tokens/anthropic 2>/dev/null || echo TOKEN_UNREADABLE"
      );
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
      expect(final.done).toBe(true);
      const expectedHome = join(dir, KEY, "acp-home", PROJECT);
      expect(final.output).toContain(`HOME=${expectedHome}`);
      expect(final.output).not.toContain(homeBase);
      expect(final.output).not.toContain("server-side-oauth-token");
      expect(final.output).not.toContain("server-side-marker");
      expect(final.output).not.toContain("test-login-token");
      expect(final.output).toContain("NO_HOME_VARS");
      expect(final.output).toContain("TOKEN_UNREADABLE");
      // The shared token file itself is untouched; it is just not under the build's home.
      expect(lstatSync(expectedHome).isDirectory()).toBe(true);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete process.env.JARVIS_TEST_SECRET_MARKER;
      delete process.env.JARVIS_CLI_HOME;
      delete process.env.JARVIS_CLI_HOME_BASE;
      rmSync(dir, { recursive: true, force: true });
      rmSync(homeBase, { recursive: true, force: true });
    }
  });

  it("replaces a planted link with a real folder and never locks the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const victim = mkdtempSync(join(tmpdir(), "acp-victim-"));
      try {
        const canary = join(victim, "canary.txt");
        writeFileSync(canary, "untouched");
        chmodSync(victim, 0o755);
        // A previous command swaps its own project folder for a link elsewhere.
        const sessionDir = join(dir, KEY, "acp", PROJECT);
        mkdirSync(join(sessionDir, ".."), { recursive: true });
        symlinkSync(victim, sessionDir);

        const host = makeHost(dir);
        const { execId } = await host.execStart(KEY, PROJECT, "pwd");
        await pollUntil(host.execPoll.bind(host, KEY, execId));
        const final = host.execPoll(KEY, execId);

        // The link is gone, a real folder stands in its place, and the build ran there.
        expect(lstatSync(sessionDir).isSymbolicLink()).toBe(false);
        expect(lstatSync(sessionDir).isDirectory()).toBe(true);
        expect(final.output.trim()).toBe(sessionDir);
        // The victim was never followed: file intact, permissions unchanged.
        expect(readFileSync(canary, "utf8")).toBe("untouched");
        expect(statSync(victim).mode & 0o777).toBe(0o755);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps build records across sessions, evicting finished ones first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const { EventEmitter } = await import("node:events");
      const children: InstanceType<typeof EventEmitter>[] = [];
      const stopped: unknown[] = [];
      const host = new AcpHost({
        neutralBase: dir,
        spawnExec: () => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => {
              stopped.push(child);
              return true;
            }
          }) as never;
          children.push(child as InstanceType<typeof EventEmitter>);
          return child;
        }
      });
      // Fill the cross-session cap with running builds, spreading them so no
      // single session hits its own cap first.
      const sessions = MAX_EXECS_TOTAL / MAX_EXECS_PER_SESSION;
      for (let s = 0; s < sessions; s++) {
        for (let i = 0; i < MAX_EXECS_PER_SESSION; i++) {
          await host.execStart(`workshop:user:cap${s}`, PROJECT, "sleep 30");
        }
      }
      // Everything held is still running, so there is nothing safe to evict.
      // The refusal stops the build it had just started: the cap bounds
      // running builds, not just records.
      await expect(host.execStart("workshop:user:other", PROJECT, "echo hi")).rejects.toThrow(
        /across sessions/
      );
      expect(stopped).toHaveLength(1);
      // Finishing one build makes room: the next start evicts it and runs.
      const finished = children.at(0);
      if (!finished) throw new Error("expected a build to finish");
      finished.emit("exit", 0);
      const { execId } = await host.execStart("workshop:user:other", PROJECT, "echo hi");
      expect(execId).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a deadline on disk so a restarted runner still stops the build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30", 60_000);
      // Deadline records live in the one folder the startup clean-out spares.
      const recordPath = join(dir, "acp-deadlines", KEY, `${execId}.json`);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        pid: number;
        deadlineAt: number;
      };
      expect(record.pid).toBeGreaterThan(0);
      expect(record.deadlineAt).toBeGreaterThan(Date.now());
      // The restart lands after the deadline has passed.
      writeFileSync(recordPath, JSON.stringify({ ...record, deadlineAt: Date.now() - 1000 }));

      // A new runner process picks up the leftover deadline and stops the build.
      const restarted = makeHost(dir);
      await restarted.reapOrphanedExecs();
      await pollUntilPidGone(record.pid);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arms the leftover deadline when the build is still within it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    let pid = -1;
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      child.unref();
      pid = child.pid ?? -1;
      expect(pid).toBeGreaterThan(0);
      // A deadline record from a dead runner, plus junk the sweep must ignore.
      mkdirSync(join(dir, "acp-deadlines", KEY), { recursive: true });
      const recordPath = join(dir, "acp-deadlines", KEY, "7.json");
      writeFileSync(
        recordPath,
        JSON.stringify({
          pid,
          deadlineAt: Date.now() + 300,
          sessionKey: KEY,
          projectId: PROJECT,
          startedAt: Date.now(),
          startTime: procStartTime(pid)
        })
      );
      writeFileSync(join(dir, "acp-deadlines", KEY, "junk.txt"), "not a record");
      writeFileSync(join(dir, "acp-deadlines", KEY, "bad.json"), "{nope");

      const restarted = makeHost(dir);
      await restarted.reapOrphanedExecs();
      // Still within the deadline: the build stands and the record stays armed.
      expect(process.kill(pid, 0)).toBe(true);
      expect(existsSync(recordPath)).toBe(true);
      await pollUntilPidGone(pid);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      if (pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the deadline record once the build finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "echo done");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      expect(host.execPoll(KEY, execId).done).toBe(true);
      // This runner saw the end, so nothing is left for a restart to pick up.
      expect(existsSync(join(dir, "acp-deadlines", KEY, `${execId}.json`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops no process it cannot prove is the recorded build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    let pid = -1;
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      child.unref();
      pid = child.pid ?? -1;
      const real = procStartTime(pid);
      expect(real).not.toBeNull();
      // Three leftover records naming this live process: one with another
      // build's start time, one with no start time at all, and one in the
      // per-session spot the first version used (which this runner must not
      // act on). All are overdue.
      const recordDir = join(dir, "acp-deadlines", KEY);
      mkdirSync(recordDir, { recursive: true });
      const wrongPath = join(recordDir, "11.json");
      writeFileSync(
        wrongPath,
        JSON.stringify({
          pid,
          deadlineAt: Date.now() - 1000,
          sessionKey: KEY,
          projectId: PROJECT,
          startedAt: Date.now(),
          startTime: String(Number(real) + 1)
        })
      );
      const nullPath = join(recordDir, "12.json");
      writeFileSync(
        nullPath,
        JSON.stringify({
          pid,
          deadlineAt: Date.now() - 1000,
          sessionKey: KEY,
          projectId: PROJECT,
          startedAt: Date.now(),
          startTime: null
        })
      );
      const legacyDir = join(dir, KEY, "acp-exec");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "13.json"),
        JSON.stringify({ pid, deadlineAt: Date.now() - 1000 })
      );

      const host = makeHost(dir);
      await host.reapOrphanedExecs();

      // Something else's process stands, and the stray records are gone.
      expect(process.kill(pid, 0)).toBe(true);
      expect(existsSync(wrongPath)).toBe(false);
      expect(existsSync(nullPath)).toBe(false);
    } finally {
      if (pid > 0) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sweep removes the session folder with its last record, and empty leftovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      // One overdue record with no start time: dropped without touching any
      // process, leaving its session folder empty.
      const recordDir = join(dir, "acp-deadlines", KEY);
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(
        join(recordDir, "9.json"),
        JSON.stringify({
          pid: 123456789,
          deadlineAt: Date.now() - 1000,
          sessionKey: KEY,
          projectId: PROJECT,
          startedAt: Date.now(),
          startTime: null
        })
      );
      // A folder an earlier owner emptied by seeing the finish itself.
      const leftoverDir = join(dir, "acp-deadlines", "workshop:user:gone");
      mkdirSync(leftoverDir, { recursive: true });

      const host = makeHost(dir);
      await host.reapOrphanedExecs();

      expect(existsSync(join(recordDir, "9.json"))).toBe(false);
      expect(existsSync(recordDir)).toBe(false);
      expect(existsSync(leftoverDir)).toBe(false);
      expect(existsSync(join(dir, "acp-deadlines"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arms no backup timer for a build this runner is already running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30", 2000);
      const recordPath = join(dir, "acp-deadlines", KEY, `${execId}.json`);
      expect(existsSync(recordPath)).toBe(true);
      // Another start's backstop sweep sees the live build and must leave it
      // to its own deadline instead of arming a second kill timer.
      await host.reapOrphanedExecs();
      host.execKill(KEY, execId);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      // A canary where the record was: a stray backup timer would delete it
      // when the original deadline arrives.
      writeFileSync(recordPath, "canary");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(readFileSync(recordPath, "utf8")).toBe("canary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a restarted runner stands down once the owner saw the finish", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30", 60_000);
      const recordPath = join(dir, "acp-deadlines", KEY, `${execId}.json`);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        pid: number;
        deadlineAt: number;
      };
      // The restart lands just before the deadline, so it arms a backup timer.
      writeFileSync(recordPath, JSON.stringify({ ...record, deadlineAt: Date.now() + 600 }));
      const restarted = makeHost(dir);
      await restarted.reapOrphanedExecs();
      // The owner stops the build and sees the finish; the record is gone.
      host.execKill(KEY, execId);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      expect(existsSync(recordPath)).toBe(false);
      // A canary where the record was: the backup timer must stand down
      // instead of killing and unlinking blindly.
      writeFileSync(recordPath, "canary");
      await pollUntilPidGone(record.pid);
      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(readFileSync(recordPath, "utf8")).toBe("canary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the deadline record without following a planted link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const victimNew = join(dir, "victim-new.txt");
      writeFileSync(victimNew, "new-victim-content");
      const victimOld = join(dir, "victim-old.txt");
      writeFileSync(victimOld, "old-victim-content");
      // The next build id is predictable, so a previous command can plant a
      // link at the record's name, at the current spot or the old one.
      const recordDir = join(dir, "acp-deadlines", KEY);
      mkdirSync(recordDir, { recursive: true });
      symlinkSync(victimNew, join(recordDir, "1.json"));
      const legacyDir = join(dir, KEY, "acp-exec");
      mkdirSync(legacyDir, { recursive: true });
      symlinkSync(victimOld, join(legacyDir, "1.json"));

      const host = makeHost(dir);
      const { execId } = await host.execStart(KEY, PROJECT, "sleep 30");

      // A real record stands in place; neither victim was written through.
      const recordPath = join(recordDir, `${execId}.json`);
      expect(lstatSync(recordPath).isSymbolicLink()).toBe(false);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number };
      expect(record.pid).toBeGreaterThan(0);
      expect(readFileSync(victimNew, "utf8")).toBe("new-victim-content");
      expect(readFileSync(victimOld, "utf8")).toBe("old-victim-content");
      host.execKill(KEY, execId);
      await pollUntil(host.execPoll.bind(host, KEY, execId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a planted link at a parent folder on the build path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      const victim = mkdtempSync(join(tmpdir(), "acp-victim-"));
      try {
        // A previous command swaps the whole session folder for a link elsewhere.
        mkdirSync(join(dir, KEY), { recursive: true });
        symlinkSync(victim, join(dir, KEY, "acp"));

        const host = makeHost(dir);
        const { execId } = await host.execStart(KEY, PROJECT, "pwd");
        await pollUntil(host.execPoll.bind(host, KEY, execId));
        const final = host.execPoll(KEY, execId);

        // Every level is real, the build ran in the real folder, and nothing
        // was ever created inside the victim.
        const sessionDir = join(dir, KEY, "acp", PROJECT);
        expect(lstatSync(join(dir, KEY, "acp")).isSymbolicLink()).toBe(false);
        expect(final.output.trim()).toBe(sessionDir);
        expect(final.exitCode).toBe(0);
        expect(readdirSync(victim)).toHaveLength(0);
      } finally {
        rmSync(victim, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the refused build when one session hits its cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    const pids: number[] = [];
    try {
      const { spawn } = await import("node:child_process");
      const host = new AcpHost({
        neutralBase: dir,
        spawnExec: (opts) => {
          const child = spawn("sh", ["-c", opts.command], {
            cwd: opts.cwd,
            env: opts.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true
          });
          if (child.pid !== undefined) pids.push(child.pid);
          return child as never;
        }
      });
      for (let i = 0; i < MAX_EXECS_PER_SESSION; i++) {
        await host.execStart(KEY, PROJECT, "sleep 30");
      }
      await expect(host.execStart(KEY, PROJECT, "sleep 30")).rejects.toThrow(/this session/);
      // The refusal stopped the build it had just started: the newest process
      // is gone while the tracked builds still stand.
      const refused = pids.at(-1);
      if (refused === undefined) throw new Error("expected a refused build");
      await pollUntilPidGone(refused);
      for (const pid of pids.slice(0, MAX_EXECS_PER_SESSION)) {
        expect(process.kill(pid, 0)).toBe(true);
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a bad project, an empty command, and a bad deadline before spawning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-exec-"));
    try {
      let spawned = 0;
      const host = new AcpHost({
        neutralBase: dir,
        spawnExec: () => {
          spawned += 1;
          throw new Error("must not spawn");
        }
      });
      await expect(host.execStart(KEY, "../escape", "echo hi")).rejects.toThrow(/projectId/);
      await expect(host.execStart(KEY, PROJECT, "")).rejects.toThrow(/command/);
      await expect(host.execStart(KEY, PROJECT, "echo hi", 0)).rejects.toThrow(/timeoutMs/);
      await expect(host.execStart(KEY, PROJECT, "echo hi", 11 * 60 * 1000)).rejects.toThrow(
        /timeoutMs/
      );
      expect(() => host.execPoll(KEY, -1)).toThrow();
      expect(() => host.execPoll(KEY, 999_999)).toThrow(/not running/);
      expect(spawned).toBe(0);
      expect(ACP_EXEC_DEFAULT_TIMEOUT_MS).toBe(5 * 60 * 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
