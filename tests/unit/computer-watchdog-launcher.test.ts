import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../../scripts/computer-watchdog/trust.js";
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

const neverStarts = async (options: LaunchOptions) => {
  let calls = 0;
  await expect(
    launchHold({
      ...options,
      spawn: (command, args, spawnOptions) => (calls++, spawn(command, args, spawnOptions))
    })
  ).rejects.toThrow();
  expect(calls).toBe(0);
};

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

  describe("launchHold runs its own protections", () => {
    const ok = `fs.writeSync(3,Buffer.from([1]));${idle}`;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const copyNode = async (options: LaunchOptions) => {
      const copy = join(dirs[dirs.length - 1]!, "node-copy");
      await copyFile(process.execPath, copy);
      return copy;
    };
    const refusedAndKilled = async (options: LaunchOptions) => {
      let pid = 0;
      await expect(
        launchHold({ ...options, onSpawn: (p) => ((pid = p), pids.push(p)) })
      ).rejects.toThrow();
      expect(pid).toBeGreaterThan(0);
      expect(await gone(pid)).toBe(true);
    };
    /** First identity read is real. The second waits, so a change made in between is seen. */
    const slowSecondRead = (ms: number): Pick<LaunchOptions, "readIdentity"> => {
      let calls = 0;
      return {
        readIdentity: async (pid) => {
          if (++calls > 1) await sleep(ms);
          return processIdentity(pid);
        }
      };
    };

    it("refuses a child that is a different binary, before waiting for any byte", async () => {
      // The child never sends the byte and the wait is long, so only the first image check can
      // refuse in time. Without it this test runs into its own time limit.
      const options = await stub(idle, { ackTimeoutMs: 30000 });
      const copy = await copyNode(options);
      await refusedAndKilled({
        ...options,
        spawn: (_command, args, spawnOptions) => spawn(copy, args, spawnOptions)
      });
    }, 8000);

    it("refuses a child started with other arguments", async () => {
      const options = await stub(ok);
      await refusedAndKilled({
        ...options,
        spawn: (command, args, spawnOptions) => spawn(command, [...args, "extra"], spawnOptions)
      });
    });

    it("refuses a child that exec'd into another binary after the first check", async () => {
      // The child sends the byte, then replaces itself with a copy of node under the same
      // arguments. Pid, start time and group stay the same. Only the second image check sees it.
      const options = await stub("");
      const copy = await copyNode(options);
      const argv = JSON.stringify([
        options.nodePath,
        options.bundlePath,
        "hold",
        options.configPath
      ]);
      await writeFile(
        options.bundlePath,
        `const fs=require("node:fs");` +
          `if(process.env.EXECED){setInterval(()=>{},1000)}else{fs.writeSync(3,Buffer.from([1]));` +
          `setTimeout(()=>process.execve(${JSON.stringify(copy)},${argv},{EXECED:"1"}),300)}`
      );
      await refusedAndKilled({
        ...options,
        bundleSha256: await hashOf(options.bundlePath),
        ...slowSecondRead(900)
      });
    });

    it("refuses a second byte that arrives while the final checks run", async () => {
      const options = await stub(
        `fs.writeSync(3,Buffer.from([1]));setTimeout(()=>fs.writeSync(3,Buffer.from([1])),150);${idle}`
      );
      await refusedAndKilled({ ...options, ...slowSecondRead(700) });
    });

    it("starts the child with an empty environment in the root folder", async () => {
      const options = await stub(ok);
      let seen: SpawnOptions | undefined;
      const hold = await launchHold({
        ...options,
        spawn: (command, args, spawnOptions) => (
          (seen = spawnOptions),
          spawn(command, args, spawnOptions)
        )
      });
      pids.push(hold.identity.pid);
      expect(seen?.env).toEqual({});
      expect(seen?.cwd).toBe("/");
      hold.kill();
    });

    it("refuses a bundle over the size limit even when its hash is right", async () => {
      const options = await stub(ok);
      await writeFile(options.bundlePath, `${ok}//${"x".repeat(17 * 1024 * 1024)}`);
      await neverStarts({ ...options, bundleSha256: await hashOf(options.bundlePath) });
    });

    it("refuses a node binary over the size limit even when its hash is right", async () => {
      const options = await stub(ok);
      const big = join(dirs[dirs.length - 1]!, "big-node");
      await writeFile(big, "");
      await truncate(big, 513 * 1024 * 1024);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(big)) hash.update(chunk);
      await neverStarts({ ...options, nodePath: big, nodeSha256: hash.digest("hex") });
    }, 30000);

    it("refuses a bundle whose modification time changes while it is read", async () => {
      const options = await stub(ok);
      await neverStarts({
        ...options,
        onRead: async (path) => {
          if (path === options.bundlePath) await utimes(path, new Date(), new Date(1e12));
        }
      });
    });

    it("refuses a bundle replaced by an identical file while it is read", async () => {
      const options = await stub(ok);
      await neverStarts({
        ...options,
        onRead: async (path) => {
          if (path !== options.bundlePath) return;
          const twin = `${path}.twin`;
          await copyFile(path, twin);
          await rename(twin, path);
        }
      });
    });

    it("refuses a path that is a link, even when the trust check is bypassed", async () => {
      const options = await stub(ok);
      const link = join(dirs[dirs.length - 1]!, "link.cjs");
      await symlink(options.bundlePath, link);
      await neverStarts({ ...options, bundlePath: link });
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
