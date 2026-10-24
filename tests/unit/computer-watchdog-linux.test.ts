import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectComputerLinuxMeasurements,
  computerMonotonicMs,
  readComputerProcess
} from "../../scripts/computer-watchdog/linux.js";
import {
  ComputerWatchdogPolicy,
  type WatchdogProcessIdentity
} from "../../scripts/computer-watchdog/policy.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>())
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const unavailable = "Computer Linux measurement unavailable";
const runner = { pid: 101, processGroupId: 101, startTicks: "123" };
const watchdog = { pid: 202, processGroupId: 202, startTicks: "456" };
function procStat(identity: WatchdogProcessIdentity, state = "S", comm = "test (nested) name)") {
  const fields = Array<string>(50).fill("0");
  fields[0] = state;
  fields[2] = String(identity.processGroupId);
  fields[19] = identity.startTicks;
  return `${identity.pid} (${comm}) ${fields.join(" ")}\n`;
}
async function liveIdentity(pid: number) {
  const text = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const fields = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  return { pid, processGroupId: Number(fields[2]), startTicks: fields[19]! };
}
async function child(): Promise<ChildProcess & { pid: number }> {
  const process = spawn(
    globalThis.process.execPath,
    ["-e", 'console.log("ready");setInterval(()=>{},1000)'],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    }
  );
  cleanups.push(async () => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    const exited = once(process, "exit");
    process.kill("SIGCONT");
    process.kill("SIGKILL");
    await exited;
  });
  await once(process.stdout!, "data");
  if (!process.pid) throw new Error("Child failed startup");
  return process as ChildProcess & { pid: number };
}

/** Real files/descriptor scan, with disclosed process/memory/disk fixtures and effective-UID spy. */
async function fixture() {
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "computer-linux-"));
  cleanups.push(() => fs.rm(path, { force: true, recursive: true }));
  const root = async (name: string) => {
    const directory = join(path, name);
    await fs.mkdir(directory);
    const { dev, ino, uid, gid, mode } = await fs.lstat(directory);
    return { path: directory, dev, ino, uid, gid, mode };
  };
  const config = {
    runner: { ...runner },
    watchdog: { ...watchdog },
    home: await root("home"),
    socket: await root("socket"),
    data: await root("data")
  };
  const files = {
    runner: join(path, "runner"),
    watchdog: join(path, "watchdog"),
    memory: join(path, "memory")
  };
  await fs.writeFile(files.runner, procStat(runner));
  await fs.writeFile(files.watchdog, procStat(watchdog));
  await fs.writeFile(files.memory, "MemTotal: 999999999 kB\nMemAvailable: 16777216 kB\n");
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
    const target = String(args[0]);
    const replacement =
      target === "/proc/101/stat"
        ? files.runner
        : target === "/proc/202/stat"
          ? files.watchdog
          : target === "/proc/meminfo"
            ? files.memory
            : args[0];
    return originalOpen(replacement, args[1], args[2]);
  });
  const originalStatfs = fs.statfs;
  vi.spyOn(fs, "statfs").mockImplementation(async (...args: Parameters<typeof fs.statfs>) => {
    const value = await originalStatfs(...args);
    return String(args[0]) === "/proc"
      ? value
      : Object.assign(value, { bavail: 40n * 1024n ** 3n, bsize: 1n });
  });
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(process.hrtime, "bigint").mockReturnValue(1_000_000_000n);
  return { config, files };
}

describe("Computer Linux OS process observations", () => {
  it("reads real current and detached child identities and rejects start/group/PID replacement", async () => {
    const own = await liveIdentity(process.pid);
    expect(await readComputerProcess(own)).toEqual({ ...own, state: "running" });
    const c = await child();
    const identity = await liveIdentity(c.pid);
    expect(identity.processGroupId).toBe(c.pid);
    expect(await readComputerProcess(identity)).toEqual({ ...identity, state: "running" });
    for (const changed of [{ startTicks: "1" }, { processGroupId: c.pid + 1 }, { pid: -1 }]) {
      await expect(readComputerProcess({ ...identity, ...changed })).rejects.toThrow(unavailable);
    }
    const exited = once(c, "exit");
    c.kill("SIGKILL");
    await exited;
    await expect(readComputerProcess(identity)).rejects.toThrow(unavailable);
  });

  it("refuses an actually stopped child without treating metadata matching as liveness", async () => {
    const c = await child();
    const identity = await liveIdentity(c.pid);
    c.kill("SIGSTOP");
    await expect
      .poll(async () =>
        (await fs.readFile(`/proc/${c.pid}/stat`, "utf8"))
          .slice((await fs.readFile(`/proc/${c.pid}/stat`, "utf8")).lastIndexOf(")") + 2, -1)
          .startsWith("T ")
      )
      .toBe(true);
    await expect(readComputerProcess(identity)).rejects.toThrow(unavailable);
  });

  it.each(["Z", "X", "x", "T", "t", "?"])("rejects non-live proc state %s", async (state) => {
    const f = await fixture();
    await fs.writeFile(f.files.runner, procStat(runner, state));
    await expect(readComputerProcess(runner)).rejects.toThrow(unavailable);
  });

  it("handles spaces and closing parentheses in comm and bounds proc reads", async () => {
    const f = await fixture();
    expect(await readComputerProcess(runner)).toEqual({ ...runner, state: "running" });
    await fs.writeFile(f.files.runner, `${procStat(runner)}${" ".repeat(8192)}`);
    await expect(readComputerProcess(runner)).rejects.toThrow(unavailable);
  });
});

describe("Computer Linux partial collection, not supervision or admission", () => {
  it("collects pinned filesystem fields and composes with the actual policy only using disclosed flags", async () => {
    const f = await fixture();
    const result = await collectComputerLinuxMeasurements(f.config);
    expect(result.measuredAtMs).toBe(1000);
    expect(result.availableMemoryBytes).toBe(16 * 1024 ** 3);
    expect(result.rootAvailableBytes).toBe(40 * 1024 ** 3);
    expect(result.dataAvailableBytes).toBe(40 * 1024 ** 3);
    expect(result.homeBytes).toBeGreaterThanOrEqual(4096);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("mossHealthy");
    expect(result).not.toHaveProperty("logsBounded");
    const runId = "10000000-0000-4000-8000-000000000001";
    const policy = new ComputerWatchdogPolicy({ runId, startedAtMs: 999, runner, watchdog });
    expect(policy.sample(1000, result).status).toBe("stopped");
    const composed = new ComputerWatchdogPolicy({ runId, startedAtMs: 999, runner, watchdog });
    expect(
      composed.sample(1000, {
        ...result,
        runId,
        mossHealthy: true,
        logsBounded: true,
        stopRequested: false
      }).status
    ).toBe("healthy");
  });

  it("refuses collection without effective root and before performing I/O", async () => {
    const f = await fixture();
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    const opened = vi.mocked(fs.open).mock.calls.length;
    await expect(collectComputerLinuxMeasurements(f.config)).rejects.toThrow(unavailable);
    expect(vi.mocked(fs.open).mock.calls.length).toBe(opened);
  });

  it.each([
    ["missing", ""],
    ["wrong unit", "MemAvailable: 1 MB\n"],
    ["negative", "MemAvailable: -1 kB\n"],
    ["duplicate", "MemAvailable: 1 kB\nMemAvailable: 2 kB\n"],
    ["unsafe", "MemAvailable: 9007199254740991 kB\n"],
    ["oversized", " ".repeat(65_537)]
  ])("refuses %s memory input", async (_label, memory) => {
    const f = await fixture();
    await fs.writeFile(f.files.memory, memory);
    await expect(collectComputerLinuxMeasurements(f.config)).rejects.toThrow(unavailable);
  });

  it("anchors time before first measurement and refuses completion at the age limit", async () => {
    const f = await fixture();
    vi.spyOn(process.hrtime, "bigint")
      .mockReturnValueOnce(1_000_000_000n)
      .mockReturnValue(5_999_000_000n);
    expect((await collectComputerLinuxMeasurements(f.config)).measuredAtMs).toBe(1000);
    vi.spyOn(process.hrtime, "bigint")
      .mockReturnValueOnce(1_000_000_000n)
      .mockReturnValue(6_000_000_000n);
    await expect(collectComputerLinuxMeasurements(f.config)).rejects.toThrow(unavailable);
  });

  it("rechecks OS identity after collection and snapshots configuration before awaiting", async () => {
    const f = await fixture();
    const original = fs.opendir;
    vi.spyOn(fs, "opendir").mockImplementationOnce(
      async (...args: Parameters<typeof fs.opendir>) => {
        f.config.runner.startTicks = "999";
        await fs.writeFile(f.files.runner, procStat({ ...runner, startTicks: "999" }));
        return original(...args);
      }
    );
    await expect(collectComputerLinuxMeasurements(f.config)).rejects.toThrow(unavailable);
  });

  it("rejects changed data roots, non-procfs and unsafe disk measurements", async () => {
    const f = await fixture();
    await expect(
      collectComputerLinuxMeasurements({
        ...f.config,
        data: { ...f.config.data, ino: f.config.data.ino + 1 }
      })
    ).rejects.toThrow(unavailable);
    const original = (await vi.importActual<typeof fs>("node:fs/promises")).statfs;
    for (const override of [{ type: 1n }, { bavail: -1n }, { bavail: 2n ** 54n, bsize: 2n }]) {
      vi.spyOn(fs, "statfs").mockImplementation(async (...args: Parameters<typeof fs.statfs>) =>
        Object.assign(await original(...args), override)
      );
      await expect(collectComputerLinuxMeasurements(f.config)).rejects.toThrow(unavailable);
    }
  });

  it("shares a safe monotonic millisecond clock", () => {
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(1_999_999n);
    expect(computerMonotonicMs()).toBe(1);
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(-1_000_000n);
    expect(() => computerMonotonicMs()).toThrow(unavailable);
  });
});
