import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runConstrainedStructuredProcess,
  type ConstrainedStructuredProcessOptions
} from "./constrained-structured-process.js";
import type { StructuredChildIdentity } from "./structured-claude-engine.js";

const PRIVATE = "private-prompt-and-credential-must-not-escape";
function run(script: string, overrides: Partial<ConstrainedStructuredProcessOptions> = {}) {
  return runConstrainedStructuredProcess({
    command: process.execPath,
    args: ["-e", script],
    cwd: tmpdir(),
    env: {},
    timeoutMs: 2500,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    ...overrides
  });
}

async function stopped(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function identity(overrides: Partial<StructuredChildIdentity> = {}): StructuredChildIdentity {
  return {
    wrap: (command, args) => ({ command, args: [...args] }),
    signalGroup: async (pid, signal) => {
      process.kill(-pid, signal);
    },
    release: vi.fn(async () => {}),
    ...overrides
  };
}

describe("constrained structured process", () => {
  it("sends private input through stdin, never argv, without inheriting the parent environment", async () => {
    process.env.MOSS_SYNTHETIC_PRIVATE_ENV = PRIVATE;
    try {
      const result = await run(
        `let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,args:process.argv,env:process.env.MOSS_SYNTHETIC_PRIVATE_ENV})));`,
        { input: PRIVATE }
      );
      const parsed = JSON.parse(result.stdout);
      expect(parsed.input).toBe(PRIVATE);
      expect(parsed.args).not.toContain(PRIVATE);
      expect(parsed.env).toBeUndefined();
    } finally {
      delete process.env.MOSS_SYNTHETIC_PRIVATE_ENV;
    }
  });

  it("supports a bounded multi-frame JSON-lines dialogue and explicit completion", async () => {
    const lines: unknown[] = [];
    const result = await run(
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({reply:JSON.parse(line).step}))); setInterval(()=>{},1000);`,
      {
        input: '{"step":1}\n',
        onStdoutLine(line, controls) {
          const value = JSON.parse(line);
          lines.push(value);
          if (value.reply === 1) controls.write('{"step":2}\n');
          else controls.complete();
        }
      }
    );
    expect(lines).toEqual([{ reply: 1 }, { reply: 2 }]);
    expect(result.signal).toBe("SIGKILL");
  });

  it.each(["stdout", "stderr"])(
    "bounds %s without exposing output in the error",
    async (stream) => {
      const error = await run(
        `process.${stream}.write('${PRIVATE}'.repeat(1000)); setInterval(()=>{},1000);`
      ).catch((e) => e);
      expect(error).toMatchObject({ code: "output_limit" });
      expect(JSON.stringify(error) + error.stack).not.toContain(PRIVATE);
    }
  );

  it("bounds total stdin frames", async () => {
    await expect(
      run("setInterval(()=>{},1000)", { input: PRIVATE, maxStdinBytes: 2 })
    ).rejects.toMatchObject({ code: "input_limit" });
  });

  it("does not expose child stderr or callback exceptions", async () => {
    const error = await run(`process.stderr.write('${PRIVATE}'); process.exit(7);`).catch((e) => e);
    expect(error).toMatchObject({ code: "exit" });
    expect(error.stack).not.toContain(PRIVATE);
    const callbackError = await run("console.log('hello'); setInterval(()=>{},1000)", {
      onStdoutLine() {
        throw new Error(PRIVATE);
      }
    }).catch((e) => e);
    expect(callbackError).toMatchObject({ code: "protocol" });
    expect(callbackError.stack).not.toContain(PRIVATE);
  });

  it.each(["timeout", "cancelled", "output_limit"])(
    "kills signal-ignoring descendants on %s before releasing identity",
    async (reason) => {
      let descendant = 0;
      let leader = 0;
      let killFinished = false;
      const controller = new AbortController();
      const account = identity({
        signalGroup: async (pid, signal) => {
          leader = pid;
          process.kill(-pid, signal);
          await new Promise((resolve) => setTimeout(resolve, 40));
          killFinished = true;
        },
        release: vi.fn(async () => {
          expect(killFinished).toBe(true);
          expect(await stopped(leader)).toBe(true);
          expect(await stopped(descendant)).toBe(true);
        })
      });
      try {
        await expect(
          run(
            `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"],{stdio:'ignore'}); console.log(child.pid); process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); setInterval(()=>{},1000);`,
            {
              identity: account,
              timeoutMs: 700,
              signal: controller.signal,
              onStdoutLine(line, controls) {
                descendant = Number(line);
                if (reason === "cancelled") controller.abort();
                if (reason === "output_limit") {
                  // Trigger output overflow through an echoed stdin frame in the leader.
                  controls.write("x".repeat(5000));
                }
              },
              args: [
                "-e",
                `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"],{stdio:'ignore'}); console.log(child.pid); process.stdin.on('data',c=>process.stdout.write(c)); process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); setInterval(()=>{},1000);`
              ]
            }
          )
        ).rejects.toMatchObject({ code: reason });
        expect(descendant).toBeGreaterThan(0);
        expect(account.release).toHaveBeenCalledOnce();
      } finally {
        if (leader) {
          try {
            process.kill(-leader, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
        if (descendant) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
      }
    }
  );

  it("kills descendants even after a successful leader exits", async () => {
    let descendant = 0;
    try {
      const result = await run(
        `const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(p.pid); p.unref();`,
        {
          onStdoutLine(line) {
            descendant = Number(line);
          }
        }
      );
      expect(result.exitCode).toBe(0);
      expect(descendant).toBeGreaterThan(0);
      await expect.poll(() => stopped(descendant), { timeout: 500 }).toBe(true);
    } finally {
      if (descendant) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    }
  });

  it("switches identity before entering cwd and ignores shell startup hooks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "structured-child-"));
    const target = join(directory, "created-by-wrapper");
    const hook = join(directory, "hook");
    await writeFile(hook, `echo ${PRIVATE}; exit 17\n`);
    const account = identity({
      env: { BASH_ENV: hook },
      wrap: (command, args) => ({
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').mkdirSync(process.argv[1]); const p=require('node:child_process').spawn(process.argv[2],process.argv.slice(3),{stdio:'inherit'}); p.on('exit',c=>process.exit(c??1));`,
          target,
          command,
          ...args
        ]
      })
    });
    try {
      const result = await run("process.stdout.write(process.cwd())", {
        cwd: target,
        identity: account,
        env: { ENV: hook }
      });
      expect(result.stdout).toBe(target);
      expect(account.release).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed without releasing identity when the live group cannot be signalled", async () => {
    let pid = 0;
    const account = identity({
      signalGroup: async () => {
        throw new Error(PRIVATE);
      }
    });
    const controller = new AbortController();
    try {
      const error = await run("console.log(process.pid); setInterval(()=>{},1000)", {
        identity: account,
        signal: controller.signal,
        onStdoutLine(line) {
          pid = Number(line);
          controller.abort();
        }
      }).catch((e) => e);
      expect(error).toMatchObject({ code: "termination" });
      expect(error.stack).not.toContain(PRIVATE);
      expect(account.release).not.toHaveBeenCalled();
      await expect.poll(() => stopped(pid), { timeout: 500 }).toBe(true);
    } finally {
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }
    }
  });

  it.each(["pending", "no_kill"])(
    "bounds shutdown when identity signalling is %s",
    async (mode) => {
      const started = performance.now();
      let pid = 0;
      // Keep deliberate watchdog-removal negative runs from leaving a synthetic child behind.
      const safety = setTimeout(() => {
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
      }, 3500);

      const account = identity({
        signalGroup: () => (mode === "pending" ? new Promise<void>(() => {}) : Promise.resolve())
      });
      const controller = new AbortController();
      try {
        await expect(
          run("console.log(process.pid); setInterval(()=>{},1000)", {
            identity: account,
            signal: controller.signal,
            onStdoutLine(line) {
              pid = Number(line);
              controller.abort();
            }
          })
        ).rejects.toMatchObject({ code: "termination" });
        expect(performance.now() - started).toBeLessThan(2800);
        expect(account.release).not.toHaveBeenCalled();
        await expect.poll(() => stopped(pid), { timeout: 500 }).toBe(true);
      } finally {
        clearTimeout(safety);
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already stopped */
          }
        }
      }
    }
  );

  it("tries its own group permissions when cancellation beats the identity switch", async () => {
    const kill = vi.spyOn(process, "kill");
    const controller = new AbortController();
    const account = identity({
      signalGroup: async () => {
        throw Object.assign(new Error(PRIVATE), { code: "EPERM" });
      }
    });
    try {
      const pending = run("setInterval(()=>{},1000)", {
        identity: account,
        signal: controller.signal
      });
      controller.abort();
      const error = await pending.catch((e) => e);
      expect(["cancelled", "termination"]).toContain(error.code);
      expect(kill.mock.calls.some(([pid, signal]) => pid < 0 && signal === "SIGKILL")).toBe(true);
      expect(error.stack).not.toContain(PRIVATE);
    } finally {
      kill.mockRestore();
    }
  });

  it("sanitizes identity cleanup failures", async () => {
    const account = identity({
      release: async () => {
        throw new Error(PRIVATE);
      }
    });
    const error = await run("process.exit(0)", { identity: account }).catch((e) => e);
    expect(error).toMatchObject({ code: "cleanup" });
    expect(error.stack).not.toContain(PRIVATE);
  });

  it("accepts a wrapped ESRCH only after verifying the process group is gone", async () => {
    const account = identity({
      signalGroup: async () => {
        throw new Error("stop helper exited 1");
      }
    });
    await expect(run("process.exit(0)", { identity: account })).resolves.toMatchObject({
      exitCode: 0
    });
    expect(account.release).toHaveBeenCalledOnce();
  });

  it("releases identity after launch errors and avoids launching an already cancelled request", async () => {
    const account = identity({
      wrap: () => ({ command: "/missing-structured-executable", args: [] })
    });
    await expect(run("", { identity: account })).rejects.toMatchObject({ code: "launch" });
    expect(account.release).toHaveBeenCalledOnce();
    const wrap = vi.fn(account.wrap);
    const cancelled = identity({ wrap });
    await expect(
      run("", { identity: cancelled, signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(wrap).not.toHaveBeenCalled();
    expect(cancelled.release).toHaveBeenCalledOnce();
  });
});
