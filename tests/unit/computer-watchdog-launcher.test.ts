import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRunningImage,
  launchHold,
  type LaunchOptions
} from "../../scripts/computer-watchdog/launcher.js";

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

const hashOf = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** A stand-in watchdog that runs the given body. Descriptor 3 is the launcher's channel. */
async function stub(body: string, overrides: Partial<LaunchOptions> = {}): Promise<LaunchOptions> {
  const dir = await mkdtemp(join(tmpdir(), "launcher-"));
  dirs.push(dir);
  const bundlePath = join(dir, "stub.cjs");
  await writeFile(bundlePath, `const fs=require("node:fs");${body}`);
  return {
    nodePath: process.execPath,
    bundlePath,
    nodeSha256: await hashOf(process.execPath),
    bundleSha256: await hashOf(bundlePath),
    assertTrusted: async () => undefined,
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
    [
      "two single bytes written back to back",
      `fs.writeSync(3,Buffer.from([1]));fs.writeSync(3,Buffer.from([1]));${idle}`
    ],
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

  it("refuses extra bytes even when the socket delivers each byte separately", async () => {
    const options = await stub(`fs.writeSync(3,Buffer.from([1,1]));${idle}`, {
      ackTimeoutMs: 600,
      spawn(command, args, spawnOptions) {
        const child = spawn(command, args, spawnOptions);
        const channel = child.stdio[3];
        if (channel) {
          const emit = channel.emit.bind(channel);
          channel.emit = (event: string | symbol, ...args: unknown[]) => {
            const chunk = args[0];
            if (event !== "data" || !Buffer.isBuffer(chunk)) return emit(event, ...args);
            for (const byte of chunk) emit("data", Buffer.from([byte]));
            return true;
          };
        }
        return child;
      }
    });
    let pid = 0;
    await expect(
      launchHold({ ...options, onSpawn: (p) => ((pid = p), pids.push(p)) })
    ).rejects.toThrow();
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

  describe("file verification", () => {
    const ok = `fs.writeSync(3,Buffer.from([1]));${idle}`;
    const neverStarts = async (options: LaunchOptions) => {
      let spawned = false;
      await expect(launchHold({ ...options, onSpawn: () => (spawned = true) })).rejects.toThrow();
      expect(spawned).toBe(false);
    };

    it("refuses a bundle whose hash differs and starts nothing", async () => {
      const options = await stub(ok);
      await neverStarts({ ...options, bundleSha256: "0".repeat(64) });
    });

    it("refuses a node binary whose hash differs and starts nothing", async () => {
      const options = await stub(ok);
      await neverStarts({ ...options, nodeSha256: "0".repeat(64) });
    });

    it("refuses a bundle edited after its hash was pinned", async () => {
      const options = await stub(ok);
      await writeFile(options.bundlePath, `${ok}//`);
      await neverStarts(options);
    });

    it.each(["", "ABC", "0".repeat(63), "G".repeat(64)])(
      "refuses malformed hash %j",
      async (bad) => {
        const options = await stub(ok);
        await neverStarts({ ...options, bundleSha256: bad });
      }
    );

    it("refuses paths that are not root-owned with a closed ancestry by default", async () => {
      const options = await stub(ok);
      const { assertTrusted: _unused, ...real } = options;
      await neverStarts(real);
    });

    it("refuses a path the trust check rejects", async () => {
      const options = await stub(ok);
      await neverStarts({
        ...options,
        assertTrusted: async (path) => {
          if (path === options.bundlePath) throw new Error("untrusted");
        }
      });
    });
  });

  describe("assertRunningImage", () => {
    const start = async () => {
      const dir = await mkdtemp(join(tmpdir(), "image-"));
      dirs.push(dir);
      const script = join(dir, "s.cjs");
      await writeFile(script, idle);
      const child = spawn(process.execPath, [script, "hold"], { stdio: "ignore", detached: true });
      pids.push(child.pid!);
      await new Promise((r) => setTimeout(r, 200));
      const { dev, ino } = await stat(process.execPath, { bigint: true });
      return { pid: child.pid!, key: { dev, ino }, argv: [process.execPath, script, "hold"] };
    };

    it("accepts the verified binary running the given arguments", async () => {
      const c = await start();
      await expect(assertRunningImage(c.pid, c.key, c.argv)).resolves.toBeUndefined();
    });

    it("refuses another binary and other arguments", async () => {
      const c = await start();
      await expect(
        assertRunningImage(c.pid, { ...c.key, ino: c.key.ino + 1n }, c.argv)
      ).rejects.toThrow();
      await expect(assertRunningImage(c.pid, c.key, [...c.argv, "extra"])).rejects.toThrow();
    });
  });
});
