import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

import {
  type ConstrainedProcessError,
  runConstrainedStructuredProcess
} from "./constrained-structured-process.js";
import type { StructuredChildIdentity } from "./structured-claude-engine.js";

function request(identity: StructuredChildIdentity) {
  const controller = new AbortController();
  return runConstrainedStructuredProcess({
    command: process.execPath,
    args: ["-e", "console.log(process.pid); setInterval(()=>{},1000)"],
    cwd: tmpdir(),
    env: {},
    identity,
    signal: controller.signal,
    timeoutMs: 10000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    onStdoutLine() {
      controller.abort();
    }
  });
}

describe("structured process retained cleanup", () => {
  it("bounds failed recovery, then retries the still-live original child and releases only after close", async () => {
    let pid = 0;
    let attempt = 0;
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target < 0 && signal === "SIGKILL")
        throw Object.assign(new Error("synthetic denied"), { code: "EPERM" });
      return realKill(target, signal);
    });
    const identity: StructuredChildIdentity = {
      wrap: (command, args) => ({ command, args: [...args] }),
      signalGroup: async (target, signal) => {
        pid = target;
        if (++attempt < 3) return new Promise<void>(() => {});
        // A successful signal acknowledgement is not itself a child-close acknowledgement.
        setTimeout(() => {
          try {
            realKill(-target, signal);
          } catch {
            /* test cleanup won */
          }
        }, 80);
      },
      release: vi.fn(async () => {
        expect(() => realKill(pid, 0)).toThrow();
      })
    };
    try {
      const error = (await request(identity).catch((e) => e)) as ConstrainedProcessError;
      expect(error.code).toBe("termination");
      expect(typeof error.retryCleanup).toBe("function");
      expect(Object.keys(error)).not.toContain("retryCleanup");
      expect(identity.release).not.toHaveBeenCalled();
      const started = performance.now();
      await expect(error.retryCleanup!()).rejects.toMatchObject({ code: "termination" });
      expect(performance.now() - started).toBeLessThan(2800);
      expect(identity.release).not.toHaveBeenCalled();
      expect(realKill(pid, 0)).toBe(true);
      await error.retryCleanup!();
      expect(identity.release).toHaveBeenCalledOnce();
      await error.retryCleanup!();
      expect(identity.release).toHaveBeenCalledOnce();
      expect(attempt).toBe(3);
    } finally {
      kill.mockRestore();
      if (pid) {
        try {
          realKill(-pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    }
  });

  it("cleans an already-closed group without signalling its old PID again", async () => {
    let pid = 0;
    const signalGroup = vi.fn(async (target: number) => {
      pid = target;
      throw new Error("synthetic private diagnostic");
    });
    const identity: StructuredChildIdentity = {
      wrap: (command, args) => ({ command, args: [...args] }),
      signalGroup,
      release: vi.fn(async () => {})
    };
    const error = (await request(identity).catch((e) => e)) as ConstrainedProcessError;
    expect(error.code).toBe("termination");
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      })
      .toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const kill = vi.spyOn(process, "kill");
    try {
      await error.retryCleanup!();
      expect(identity.release).toHaveBeenCalledOnce();
      expect(signalGroup).toHaveBeenCalledOnce();
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});
