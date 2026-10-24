import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ObservationJournal,
  inspectJournal,
  JOURNAL_LIMIT
} from "../../scripts/computer-watchdog/journal.js";
import { privateJson } from "../../scripts/computer-host/state.js";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fs>()) }));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const configuration = {
  runId: "10000000-0000-4000-8000-000000000001",
  startedAtMs: 0,
  runner: { pid: 101, processGroupId: 101, startTicks: "123" },
  watchdog: { pid: 202, processGroupId: 202, startTicks: "456" }
};
async function fixture() {
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "computer-journal-"));
  await fs.chmod(path, 0o700);
  cleanups.push(() => fs.rm(path, { recursive: true, force: true }));
  const { dev, ino, uid, gid, mode } = await fs.lstat(path);
  const root = { path, dev, ino, uid, gid, mode };
  const journal = await ObservationJournal.create(root, configuration);
  cleanups.push(() => journal.close().catch(() => {}));
  return { root, journal, file: join(path, "observation.jsonl") };
}

describe("exclusive durable observation journal, real temporary files under current uid", () => {
  it("fsyncs header/identity/first stop, retains records and refuses crash reopening", async () => {
    const f = await fixture();
    await f.journal.collector(configuration.watchdog);
    await f.journal.stop(5000, "measurement-failed", configuration.watchdog);
    await expect(f.journal.stop(6000, "operator-stop", null)).rejects.toThrow();
    await f.journal.inspect();
    const records = (await fs.readFile(f.file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.map((record) => record.type)).toEqual(["start", "collector", "stop"]);
    expect(records[2]).toMatchObject({ reason: "measurement-failed", atMs: 5000 });
    await expect(ObservationJournal.create(f.root, configuration)).rejects.toThrow();
  });
  it("rejects replacement, symlink and unexpected directory content", async () => {
    const f = await fixture();
    await fs.rename(f.file, `${f.file}.old`);
    await fs.writeFile(f.file, "replacement", { mode: 0o600 });
    await expect(f.journal.inspect()).rejects.toThrow();
    await fs.unlink(f.file);
    await fs.symlink(`${f.file}.old`, f.file);
    await expect(inspectJournal(f.root)).rejects.toThrow();
    await expect(f.journal.stop(1, "operator-stop", null)).rejects.toThrow();
  });
  it("rejects permissions, hardlinks and exact byte limit", async () => {
    const f = await fixture();
    await fs.chmod(f.file, 0o644);
    await expect(inspectJournal(f.root)).rejects.toThrow();
    await fs.chmod(f.file, 0o600);
    const other = `${f.root.path}-link`;
    await fs.link(f.file, other);
    cleanups.push(() => fs.unlink(other));
    await expect(inspectJournal(f.root)).rejects.toThrow();
    await fs.unlink(other);
    cleanups.pop();
    await fs.truncate(f.file, JOURNAL_LIMIT);
    await expect(inspectJournal(f.root)).rejects.toThrow();
  });
  it("limits collector records and reserves space for a terminal record", async () => {
    const f = await fixture();
    for (let n = 0; n < 400; n++) await f.journal.collector(configuration.watchdog);
    await expect(f.journal.collector(configuration.watchdog)).rejects.toThrow();
    await f.journal.stop(1, "operator-stop", null);
    expect((await fs.stat(f.file)).size).toBeLessThan(JOURNAL_LIMIT);
    await expect(f.journal.collector(configuration.watchdog)).rejects.toThrow();
  });
  it("orders stop behind the pending append and does not hide failed fsync", async () => {
    const f = await fixture();
    const original = fs.open;
    // Disclosed native-fd spy; no changes to the append implementation or actual file writes.
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith("observation.jsonl"))
        vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("disk"));
      return handle;
    });
    const path = `${f.root.path}-failed`;
    await fs.mkdir(path, { mode: 0o700 });
    cleanups.push(() => fs.rm(path, { recursive: true, force: true }));
    const { dev, ino, uid, gid, mode } = await fs.lstat(path);
    await expect(
      ObservationJournal.create({ path, dev, ino, uid, gid, mode }, configuration)
    ).rejects.toThrow();
    expect(await fs.readFile(join(path, "observation.jsonl"), "utf8")).toContain('"type":"start"');
  });
  it("waits for prior fsync before writing the terminal record", async () => {
    const original = fs.open;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith("observation.jsonl")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync")
          .mockImplementationOnce(sync)
          .mockImplementationOnce(async () => {
            entered();
            await held;
            await sync();
          })
          .mockImplementation(sync);
      }
      return handle;
    });
    const f = await fixture();
    const append = f.journal.collector(configuration.watchdog);
    await blocked;
    const stop = f.journal.stop(5000, "measurement-failed", configuration.watchdog);
    expect(f.journal.pending).toBe(true);
    await expect(f.journal.inspect()).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).not.toContain('"type":"stop"');
    release();
    await append;
    await stop;
    expect((await fs.readFile(f.file, "utf8")).trim().split("\n").at(-1)).toContain(
      '"type":"stop"'
    );
  });
  it("refuses an actual FIFO private JSON without waiting for a writer", async () => {
    const f = await fixture();
    const fifo = join(f.root.path, "fifo");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const start = performance.now();
    await expect(privateJson(fifo)).rejects.toThrow("Unsafe host state file");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
