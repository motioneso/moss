import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createExecutableDigestCache } from "./constrained-claude-profile.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-digest-cache-"));
  roots.push(root);
  const file = join(root, "binary");
  await writeFile(file, "old");
  return { root, file };
}
it("reuses an unchanged digest and invalidates same-size/mtime edits and replacement", async () => {
  const { root, file } = await fixture();
  const digest = vi.fn(async (path: string) => readFile(path, "utf8"));
  const cached = createExecutableDigestCache(digest);
  expect(await cached(file)).toBe("old");
  expect(await cached(file)).toBe("old");
  expect(digest).toHaveBeenCalledTimes(1);
  const original = await stat(file);
  await writeFile(file, "new");
  await utimes(file, original.atime, original.mtime);
  expect(await cached(file)).toBe("new");
  expect(digest).toHaveBeenCalledTimes(2);
  const next = join(root, "replacement");
  await writeFile(next, "alt");
  await utimes(next, original.atime, original.mtime);
  await rename(next, file);
  expect(await cached(file)).toBe("alt");
  expect(digest).toHaveBeenCalledTimes(3);
});
it("does not cache a file changed during hashing and keeps the cache bounded", async () => {
  const { root, file } = await fixture();
  const digest = vi.fn(async (path: string) => readFile(path, "utf8"));
  const cached = createExecutableDigestCache(digest, 2);
  digest.mockImplementationOnce(async () => {
    await writeFile(file, "new");
    return "old";
  });
  await expect(cached(file)).rejects.toThrow("unsupported");
  expect(await cached(file)).toBe("new");
  for (const name of ["second", "third"]) {
    const p = join(root, name);
    await writeFile(p, name);
    await cached(p);
  }
  await cached(file);
  expect(digest).toHaveBeenCalledTimes(5);
});
