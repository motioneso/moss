/**
 * #2674 — the startup sweep clears a crashed structured call's leftovers, including the private
 * transcript it wrote in its owner's home.
 *
 * A non-root test cannot create a folder owned by a slot UID, so `lstat` reports the slot owner.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";

const SLOT_UIDS = new Map<string, number>();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    lstat: async (path: string) => {
      const stat = await actual.lstat(path);
      const uid = SLOT_UIDS.get(path);
      return uid === undefined ? stat : Object.assign(stat, { uid, gid: uid });
    }
  };
});

const { transcriptGlobDir } = await import("../../packages/ai/src/index.js");
const { clearOwnedStructuredFolders } =
  await import("../../packages/cli-runner/src/per-user-slot.js");

const USER = "44444444-4444-4444-8444-444444444444";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  SLOT_UIDS.clear();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("#2674 startup clean-out of slot-owned structured folders", () => {
  it("purges the owner's transcript as the owner before removing the working folder", async () => {
    const homeBase = tempDir("owned-cleanup-home-");
    const neutralBase = tempDir("owned-cleanup-neutral-");
    writeFileSync(join(homeBase, "uid-slots.json"), JSON.stringify({ [USER]: 7 }));
    const folder = join(neutralBase, "structured-66666666-ffff-4fff-8fff-666666666666");
    mkdirSync(folder);
    SLOT_UIDS.set(folder, 100_007);

    const purged: Array<{ path: string; identity: unknown }> = [];
    await clearOwnedStructuredFolders({
      neutralBase,
      homeBase,
      purgeOwnedPath: async (path, identity) => {
        purged.push({ path, identity });
      }
    });

    const identity = { uid: 100_007, gid: 100_007 };
    expect(purged).toEqual([
      { path: transcriptGlobDir("anthropic", folder, join(homeBase, "agents", USER)), identity },
      { path: folder, identity }
    ]);
  });

  it("does not guess an owner home for a slot no user holds", async () => {
    const homeBase = tempDir("owned-cleanup-home-");
    const neutralBase = tempDir("owned-cleanup-neutral-");
    writeFileSync(
      join(homeBase, "uid-slots.json"),
      JSON.stringify({ "structured-77777777-aaaa-4aaa-8aaa-777777777777": 3 })
    );
    const folder = join(neutralBase, "structured-77777777-aaaa-4aaa-8aaa-777777777777");
    mkdirSync(folder);
    SLOT_UIDS.set(folder, 100_003);

    const purged: string[] = [];
    await clearOwnedStructuredFolders({
      neutralBase,
      homeBase,
      purgeOwnedPath: async (path) => {
        purged.push(path);
      }
    });

    expect(purged).toEqual([folder]);
  });
});
