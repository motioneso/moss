import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchHold, type LaunchOptions } from "../../scripts/computer-watchdog/launcher.js";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
};

/** A stand-in watchdog that runs the given body. Descriptor 3 is the launcher's channel. */
async function stub(body: string, overrides: Partial<LaunchOptions> = {}): Promise<LaunchOptions> {
  const dir = await mkdtemp(join(tmpdir(), "launcher-"));
  dirs.push(dir);
  const bundlePath = join(dir, "stub.cjs");
  await writeFile(bundlePath, `const fs=require("node:fs");${body}`);
  return {
    nodePath: process.execPath,
    bundlePath,
    configPath: join(dir, "config.json"),
    ackTimeoutMs: 1500,
    ...overrides
  };
}
const idle = "setInterval(()=>{},1000);";

describe("launchHold", () => {
  it("accepts one start-up byte on the launcher's own channel and returns the identity", async () => {
    const hold = await launchHold(await stub(`fs.writeSync(3,Buffer.from([1]));${idle}`));
    pids.push(hold.identity.pid);
    expect(alive(hold.identity.pid)).toBe(true);
    expect(hold.identity.processGroupId).toBe(hold.identity.pid);
    hold.kill();
    expect(await gone(hold.identity.pid)).toBe(true);
  });

  it.each([
    ["no byte, still alive", idle],
    ["a different byte", `fs.writeSync(3,Buffer.from([2]));${idle}`],
    ["two bytes", `fs.writeSync(3,Buffer.from([1,1]));${idle}`],
    ["one byte then a second", `fs.writeSync(3,Buffer.from([1]));fs.writeSync(3,Buffer.from([1]));${idle}`],
    ["an early exit", "process.exit(2);"],
    ["a closed channel", `fs.closeSync(3);${idle}`]
  ])("refuses %s and leaves nothing running", async (_name, body) => {
    const options = await stub(body, { ackTimeoutMs: 600 });
    let pid = 0;
    await expect(
      launchHold({ ...options, onSpawn: (p) => ((pid = p), pids.push(p)) })
    ).rejects.toThrow();
    expect(pid).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
  });

  it("starts the child in its own process group", async () => {
    const options = await stub(`fs.writeSync(3,Buffer.from([1]));${idle}`);
    const hold = await launchHold(options);
    pids.push(hold.identity.pid);
    expect(hold.identity.processGroupId).not.toBe(process.pid);
    hold.kill();
  });

  it("refuses when the launcher holds no end of the channel", async () => {
    // The child can still write, but nothing in the launcher can read it.
    const options = await stub(`fs.writeSync(3,Buffer.from([1]));${idle}`, {
      ackTimeoutMs: 600,
      spawn: (command, args, spawnOptions) =>
        spawn(command, args, {
          ...spawnOptions,
          stdio: ["ignore", "ignore", "ignore", "ignore"]
        })
    });
    let pid = 0;
    await expect(
      launchHold({ ...options, onSpawn: (p) => ((pid = p), pids.push(p)) })
    ).rejects.toThrow();
    expect(await gone(pid)).toBe(true);
  });

  it("refuses when the child's identity changes between spawn and the byte", async () => {
    const options = await stub(`fs.writeSync(3,Buffer.from([1]));${idle}`);
    let calls = 0;
    let pid = 0;
    await expect(
      launchHold({
        ...options,
        onSpawn: (p) => ((pid = p), pids.push(p)),
        readIdentity: async (p) => ({
          pid: p,
          processGroupId: p,
          startTicks: String(calls++)
        })
      })
    ).rejects.toThrow();
    expect(await gone(pid)).toBe(true);
  });
});
