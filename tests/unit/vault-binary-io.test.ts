import type * as FsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  stat,
  statfs,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultFileBytes,
  getVaultAvailableBytes,
  readVaultFileBytes,
  readVaultFileRange,
  VAULT_READ_RANGE_LIMIT,
  VaultContextRunner,
  VaultPathError,
  vaultFileExists,
  type VaultContext
} from "@moss/vault";

const fault = vi.hoisted(() => ({ partialWrite: false, sync: "", earlyEof: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (fault.sync && String(args[0]).endsWith(fault.sync)) {
        vi.spyOn(handle, "sync").mockRejectedValue(new Error("synthetic sync failure"));
      }
      if (fault.earlyEof) {
        vi.spyOn(handle, "read").mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
      }
      return handle;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (fault.partialWrite) {
        await actual.writeFile(args[0], Buffer.from([255]), args[2]);
        throw new Error("synthetic disk failure");
      }
      return actual.writeFile(...args);
    }
  };
});

let root: string;
let ctx: VaultContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-vault-binary-"));
  ctx = await new VaultContextRunner(root).withVaultContext(
    { actorUserId: "synthetic-owner", requestId: "test" },
    async (context) => context
  );
});
afterEach(async () => {
  fault.partialWrite = false;
  fault.sync = "";
  fault.earlyEof = false;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("immutable binary publication", () => {
  it("refuses a vault-root target before creating a temporary sibling", async () => {
    await expect(createVaultFileBytes(ctx, ".", Buffer.from([1]))).rejects.toBeInstanceOf(
      VaultPathError
    );
    expect(await readdir(root)).toEqual(["synthetic-owner"]);
  });

  it("preserves non-UTF8 bytes and leaves one complete winner on concurrent creation", async () => {
    const first = Buffer.from([0, 128, 255, 1]);
    const second = Buffer.from([128, 0, 254]);
    const outcomes = await Promise.all([
      createVaultFileBytes(ctx, "chunks/0", first),
      createVaultFileBytes(ctx, "chunks/0", second)
    ]);
    expect(outcomes.sort()).toEqual(["created", "exists"]);
    const stored = await readVaultFileBytes(ctx, "chunks/0");
    expect([first, second].some((bytes) => stored.equals(bytes))).toBe(true);
    expect(await createVaultFileBytes(ctx, "chunks/0", Buffer.from("changed"))).toBe("exists");
    expect(await readVaultFileBytes(ctx, "chunks/0")).toEqual(stored);
    expect(await readdir(join(ctx.vaultRoot, "chunks"))).toEqual(["0"]);
    expect((await stat(join(ctx.vaultRoot, "chunks/0"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(ctx.vaultRoot, "chunks"))).mode & 0o777).toBe(0o700);
  });

  it("cleans a failed partial write without publishing bytes", async () => {
    fault.partialWrite = true;
    await expect(createVaultFileBytes(ctx, "chunks/0", Buffer.from([1, 2]))).rejects.toThrow(
      "synthetic disk failure"
    );
    expect(await vaultFileExists(ctx, "chunks/0")).toBe(false);
    expect(await readdir(join(ctx.vaultRoot, "chunks"))).toEqual([]);
    fault.partialWrite = false;
    expect(await createVaultFileBytes(ctx, "chunks/0", Buffer.from([1, 2]))).toBe("created");
  });

  it("does not publish when the file cannot be synced", async () => {
    fault.sync = ".tmp";
    await expect(createVaultFileBytes(ctx, "chunks/0", Buffer.from([1]))).rejects.toThrow(
      "synthetic sync failure"
    );
    expect(await vaultFileExists(ctx, "chunks/0")).toBe(false);
    expect(await readdir(join(ctx.vaultRoot, "chunks"))).toEqual([]);
  });

  it("replays publication after a lost directory-sync acknowledgement", async () => {
    fault.sync = "/chunks";
    await expect(createVaultFileBytes(ctx, "chunks/0", Buffer.from([1]))).rejects.toThrow(
      "synthetic sync failure"
    );
    expect(await readVaultFileBytes(ctx, "chunks/0")).toEqual(Buffer.from([1]));
    // A replay must still attempt directory sync rather than return exists immediately.
    await expect(createVaultFileBytes(ctx, "chunks/0", Buffer.from([1]))).rejects.toThrow(
      "synthetic sync failure"
    );
    fault.sync = "";
    expect(await createVaultFileBytes(ctx, "chunks/0", Buffer.from([1]))).toBe("exists");
    expect(await readdir(join(ctx.vaultRoot, "chunks"))).toEqual(["0"]);
  });
});

describe("bounded range reads", () => {
  it("reads the requested bytes, including the final byte", async () => {
    await createVaultFileBytes(ctx, "chunk", Buffer.from([0, 128, 255, 10, 11]));
    expect(await readVaultFileRange(ctx, "chunk", 1, 3)).toEqual(Buffer.from([128, 255, 10]));
    expect(await readVaultFileRange(ctx, "chunk", 4, 1)).toEqual(Buffer.from([11]));
    await expect(readVaultFileRange(ctx, "chunk", 4, 2)).rejects.toThrow(RangeError);
  });

  it.each([
    [-1, 1],
    [0.5, 1],
    [NaN, 1],
    [Infinity, 1],
    [0, 0],
    [0, -1],
    [0, 1.5],
    [0, VAULT_READ_RANGE_LIMIT + 1],
    [Number.MAX_SAFE_INTEGER, 1]
  ])("rejects invalid bounds (%s, %s)", async (offset, length) => {
    await expect(readVaultFileRange(ctx, "not-opened", offset, length)).rejects.toThrow(RangeError);
  });

  it("reads a 1 MiB range from a two-hour-sized sparse fixture without reading the whole file", async () => {
    const handle = await open(join(ctx.vaultRoot, "large.wav"), "wx", 0o600);
    const size = 7_200_000 * 32 + 44;
    try {
      await handle.truncate(size);
      await handle.write(Buffer.from([1, 2, 3, 4]), 0, 4, size - 4);
    } finally {
      await handle.close();
    }
    const allocation = vi.spyOn(Buffer, "alloc");
    const bytes = await readVaultFileRange(
      ctx,
      "large.wav",
      size - VAULT_READ_RANGE_LIMIT,
      VAULT_READ_RANGE_LIMIT
    );
    expect(bytes.length).toBe(VAULT_READ_RANGE_LIMIT);
    expect(bytes.subarray(-4)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(allocation.mock.calls.every(([length]) => length <= VAULT_READ_RANGE_LIMIT)).toBe(true);
  });

  it("fails on an early EOF after file-size validation", async () => {
    await createVaultFileBytes(ctx, "chunk", Buffer.from([1, 2, 3]));
    fault.earlyEof = true;
    await expect(readVaultFileRange(ctx, "chunk", 0, 3)).rejects.toThrow(RangeError);
  });

  it("rejects directories", async () => {
    await mkdir(join(ctx.vaultRoot, "chunks"));
    await expect(readVaultFileRange(ctx, "chunks", 0, 1)).rejects.toThrow(RangeError);
  });
});

it("reports filesystem available space without claiming a reservation", async () => {
  const info = await statfs(ctx.vaultRoot, { bigint: true });
  const available = await getVaultAvailableBytes(ctx);
  expect(typeof available).toBe("bigint");
  expect(available).toBeGreaterThan(0n);
  // Other writers can change free space between these calls.
  expect(available).toBeLessThanOrEqual(info.blocks * info.bsize);
});

it.each(["range read", "binary publication"] as const)(
  "rejects traversal and symlink escapes for %s",
  async (operation) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "chunk"), Buffer.from([1, 2]));
    await symlink(outside, join(ctx.vaultRoot, "escape"), "dir");
    for (const path of ["../outside/chunk", "escape/chunk"]) {
      const action =
        operation === "range read"
          ? readVaultFileRange(ctx, path, 0, 1)
          : createVaultFileBytes(ctx, path, Buffer.from([2]));
      await expect(action).rejects.toBeInstanceOf(VaultPathError);
    }
  }
);
