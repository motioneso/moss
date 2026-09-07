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
      const host = new AcpHost({
        neutralBase: dir,
        resolveAdapterEntry: () => "/fake/adapter.js",
        spawnChild: () => child
      });
      const spawned = await host.spawn(KEY, PROJECT);
      const { execId } = await host.execStart(KEY, PROJECT, "pwd");
      await pollUntil(host.execPoll.bind(host, KEY, execId));
      const final = host.execPoll(KEY, execId);
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
      const host = new AcpHost({
        neutralBase: dir,
        spawnExec: () => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            kill: () => true
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
      await expect(host.execStart("workshop:user:other", PROJECT, "echo hi")).rejects.toThrow(
        /across sessions/
      );
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
      const recordPath = join(dir, KEY, "acp-exec", `${execId}.json`);
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
      mkdirSync(join(dir, KEY, "acp-exec"), { recursive: true });
      const recordPath = join(dir, KEY, "acp-exec", "7.json");
      writeFileSync(
        recordPath,
        JSON.stringify({
          pid,
          deadlineAt: Date.now() + 300,
          sessionKey: KEY,
          projectId: PROJECT,
          startedAt: Date.now()
        })
      );
      writeFileSync(join(dir, KEY, "acp-exec", "junk.txt"), "not a record");
      writeFileSync(join(dir, KEY, "acp-exec", "bad.json"), "{nope");

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
      expect(existsSync(join(dir, KEY, "acp-exec", `${execId}.json`))).toBe(false);
    } finally {
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
