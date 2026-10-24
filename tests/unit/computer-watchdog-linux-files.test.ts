import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureComputerTree } from "../../scripts/computer-watchdog/linux-files.js";
import type { RootIdentity } from "../../scripts/computer-host/config.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof fs>())
}));

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const path = await fs.mkdtemp(join(await fs.realpath(tmpdir()), "computer-measure-"));
  cleanups.push(() => fs.rm(path, { force: true, recursive: true }));
  const { dev, ino, uid, gid, mode } = await fs.lstat(path);
  return { path, dev, ino, uid, gid, mode } satisfies RootIdentity;
}
const unavailable = "Computer Linux measurement unavailable";

describe("Computer Linux descriptor-relative sampled tree accounting", () => {
  it("counts sparse logical bytes and repeated hardlinks without following external symlinks", async () => {
    const root = await fixture();
    const external = await fixture();
    await fs.writeFile(join(external.path, "large"), "");
    await fs.truncate(join(external.path, "large"), 1_000_000_000);
    await fs.symlink(join(external.path, "large"), join(root.path, "outside"));
    await fs.writeFile(join(root.path, "sparse"), "");
    await fs.truncate(join(root.path, "sparse"), 1_000_000);
    await fs.link(join(root.path, "sparse"), join(root.path, "hardlink"));
    await fs.mkdir(join(root.path, "nested"));
    await fs.writeFile(join(root.path, "nested", "small"), "x");
    const bytes = await measureComputerTree(root);
    expect(bytes).toBeGreaterThanOrEqual(2_000_000 + 4 * 4096);
    expect(bytes).toBeLessThan(3_000_000);
  });

  it("accounts FIFOs and Unix sockets without opening their contents", async () => {
    const root = await fixture();
    execFileSync("mkfifo", [join(root.path, "fifo")]);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(root.path, "socket"), resolve);
    });
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    expect(await measureComputerTree(root)).toBeGreaterThanOrEqual(3 * 4096);
  });

  it("rejects invalid UTF8 names that alias a smaller replacement-character sibling", async () => {
    const root = await fixture();
    const opaque = Buffer.concat([Buffer.from(`${root.path}/`), Buffer.from([0xff])]);
    await fs.writeFile(opaque, "");
    await fs.truncate(opaque, 1_000_000);
    await fs.writeFile(join(root.path, "\uFFFD"), "x");
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
  });

  it("refuses a replacement root and a symlink to the original inode", async () => {
    const root = await fixture();
    const moved = `${root.path}-moved`;
    cleanups.push(() => fs.rm(moved, { force: true, recursive: true }));
    await fs.rename(root.path, moved);
    await fs.mkdir(root.path);
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
    await fs.rmdir(root.path);
    await fs.symlink(moved, root.path);
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
  });

  it("rejects a child symlink even when it resolves to the originally observed directory inode", async () => {
    const root = await fixture();
    const external = await fixture();
    await fs.mkdir(join(root.path, "child"));
    const original = fs.open;
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/child") && !replaced) {
        replaced = true;
        const moved = join(external.path, "moved");
        await fs.rename(join(root.path, "child"), moved);
        await fs.symlink(moved, join(root.path, "child"));
      }
      return original(...args);
    });
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
    expect(replaced).toBe(true);
  });

  it("rejects an opened replacement directory inode even without a symlink", async () => {
    const root = await fixture();
    await fs.mkdir(join(root.path, "child"));
    const original = fs.open;
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]).endsWith("/child") && !replaced) {
        replaced = true;
        await fs.rename(join(root.path, "child"), join(root.path, "old"));
        await fs.mkdir(join(root.path, "child"));
      }
      return original(...args);
    });
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
  });

  it("keeps descriptor traversal inside the opened root and rejects renamed pathname at completion", async () => {
    const root = await fixture();
    await fs.writeFile(join(root.path, "leaf"), "x");
    const moved = `${root.path}-moved`;
    cleanups.push(() => fs.rm(moved, { force: true, recursive: true }));
    const original = fs.opendir;
    vi.spyOn(fs, "opendir").mockImplementationOnce(
      async (...args: Parameters<typeof fs.opendir>) => {
        await fs.rename(root.path, moved);
        await fs.mkdir(root.path);
        return original(...args);
      }
    );
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
    expect(await fs.readFile(join(moved, "leaf"), "utf8")).toBe("x");
  });

  it("bounds directory depth and closes all descriptors on scan failure", async () => {
    const root = await fixture();
    let path = root.path;
    for (let i = 0; i < 33; i++) {
      path = join(path, "d");
      await fs.mkdir(path);
    }
    const before = (await fs.readdir("/proc/self/fd")).length;
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
    const after = (await fs.readdir("/proc/self/fd")).length;
    expect(after).toBe(before);
  });

  it("bounds streamed entry work rather than trusting directory size", async () => {
    const root = await fixture();
    await fs.writeFile(join(root.path, "leaf"), "x");
    const original = fs.opendir;
    let reads = 0;
    vi.spyOn(fs, "opendir").mockImplementationOnce(
      async (...args: Parameters<typeof fs.opendir>) => {
        const iterator = await original(...args);
        const entry = await iterator.read();
        vi.spyOn(iterator, "read").mockImplementation(async () => {
          reads++;
          return entry;
        });
        return iterator;
      }
    );
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
    expect(reads).toBe(100_000);
  });

  it("rejects cross-device accounting, overflow and metadata read failures", async () => {
    const root = await fixture();
    await fs.writeFile(join(root.path, "leaf"), "x");
    const original = fs.lstat;
    for (const override of [{ dev: BigInt(root.dev) + 1n }, { size: 2n ** 54n }]) {
      vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original(...args);
        return String(args[0]).endsWith("/leaf") ? Object.assign(stat, override) : stat;
      });
      await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
      vi.restoreAllMocks();
    }
    vi.spyOn(fs, "opendir").mockRejectedValue(new Error("private path must not escape"));
    await expect(measureComputerTree(root)).rejects.toThrow(unavailable);
  });
});
