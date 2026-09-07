/**
 * Engine startup (#2396 fix round 1): the clean-out spares the build deadline
 * records, and the orphan sweep runs after the clean-out — never beside it.
 * Real folders, a real orphaned build, real assertions about who survived.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";

const KEY = "workshop:user:proj";
// Mirrors the deadline folder the runner owns; the startup clean-out must
// spare exactly this name.
const DEADLINE_DIR = "acp-deadlines";

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
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the build to die");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Shell commands against the real filesystem, so the wipe really wipes. */
function realFsIo(): TmuxIo {
  const run = async (cmd: string, args: readonly string[]) => {
    if (cmd === "tmux") return { code: 0, stdout: "", stderr: "" };
    if (cmd === "ls") {
      try {
        const names = readdirSync(args[1] as string);
        return { code: 0, stdout: names.join("\n"), stderr: "" };
      } catch {
        return { code: 1, stdout: "", stderr: "" };
      }
    }
    if (cmd === "rm") {
      try {
        rmSync(args[1] as string, { recursive: true, force: true });
      } catch {
        /* best effort, like the sweep */
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "mkdir" || cmd === "chmod" || cmd === "find") {
      if (cmd === "mkdir") mkdirSync(args[1] as string, { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const readFile = async (path: string): Promise<string> => readFileSync(path, "utf8");
  return {
    run: run as unknown as TmuxIo["run"],
    readFile: readFile as unknown as TmuxIo["readFile"],
    writeFile: (async () => undefined) as unknown as TmuxIo["writeFile"],
    sleep: (async () => undefined) as unknown as TmuxIo["sleep"]
  };
}

describe("engine startup orphan sweep", () => {
  it("spares deadline records through the clean-out and then stops the orphan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-sweep-"));
    let pid = -1;
    try {
      // Stale residue from before the restart: wiped.
      const staleDir = join(dir, "workshop:user:stale", "acp", "proj");
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, "stale.txt"), "stale");
      // An orphaned build with an overdue deadline and a true start time.
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
      child.unref();
      pid = child.pid ?? -1;
      expect(pid).toBeGreaterThan(0);
      const startTime = procStartTime(pid);
      expect(startTime).not.toBeNull();
      const recordDir = join(dir, DEADLINE_DIR, KEY);
      mkdirSync(recordDir, { recursive: true });
      const recordPath = join(recordDir, "5.json");
      writeFileSync(
        recordPath,
        JSON.stringify({
          pid,
          deadlineAt: Date.now() - 1000,
          sessionKey: KEY,
          projectId: "proj",
          startedAt: Date.now(),
          startTime
        })
      );

      const host = new CliChatEngineHost({
        io: realFsIo(),
        neutralBase: dir,
        singleUser: true,
        cliPresent: async () => true
      });
      await host.startupSweep();

      // The residue is gone, the record was consumed, the orphan was stopped.
      expect(existsSync(join(dir, "workshop:user:stale"))).toBe(false);
      expect(existsSync(recordPath)).toBe(false);
      await pollUntilPidGone(pid);
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
});
