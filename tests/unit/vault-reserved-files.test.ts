import { link, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  publishReservedVaultFileBytes,
  readVaultFileRange,
  reserveVaultFileBytes,
  VaultContextRunner,
  VaultPathError,
  type VaultContext
} from "@moss/vault";

let root: string, ctx: VaultContext;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-reserved-"));
  ctx = await new VaultContextRunner(root).withVaultContext(
    { actorUserId: "synthetic" },
    async (ctx) => ctx
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("allocated immutable Vault chunks", () => {
  it("allocates real blocks and publishes the same inode without a second source copy", async () => {
    const bytes = Buffer.alloc(1024 * 1024, 137);
    await reserveVaultFileBytes(ctx, "upload/0.bin", bytes.length);
    const reserved = await stat(join(ctx.vaultRoot, "upload/0.bin.reserved"));
    expect(reserved.size).toBe(bytes.length);
    expect(reserved.blocks * 512).toBeGreaterThanOrEqual(bytes.length);
    expect(await readdir(join(ctx.vaultRoot, "upload"))).toEqual(["0.bin.reserved"]);
    expect(await publishReservedVaultFileBytes(ctx, "upload/0.bin", bytes)).toBe("created");
    const published = await stat(join(ctx.vaultRoot, "upload/0.bin"));
    expect(published.ino).toBe(reserved.ino);
    expect(published.mode & 0o777).toBe(0o600);
    expect(await readVaultFileRange(ctx, "upload/0.bin", 0, bytes.length, bytes.length)).toEqual(
      bytes
    );
  });
  it("resumes interrupted allocation and overwrites an interrupted unpublished payload", async () => {
    await mkdir(join(ctx.vaultRoot, "upload"));
    await writeFile(join(ctx.vaultRoot, "upload/0.bin.reserved"), Buffer.from([255, 254]));
    await reserveVaultFileBytes(ctx, "upload/0.bin", 4096);
    expect((await stat(join(ctx.vaultRoot, "upload/0.bin.reserved"))).size).toBe(4096);
    const bytes = Buffer.alloc(4096, 42);
    await publishReservedVaultFileBytes(ctx, "upload/0.bin", bytes);
    expect(await readVaultFileRange(ctx, "upload/0.bin", 0, 4096, 4096)).toEqual(bytes);
  });
  it("repairs lost publication acknowledgement without changing published bytes", async () => {
    await reserveVaultFileBytes(ctx, "upload/0.bin", 3);
    const pending = join(ctx.vaultRoot, "upload/0.bin.reserved");
    await writeFile(pending, Buffer.from([1, 2, 3]));
    await link(pending, join(ctx.vaultRoot, "upload/0.bin"));
    expect(await publishReservedVaultFileBytes(ctx, "upload/0.bin", Buffer.from([4, 5, 6]))).toBe(
      "exists"
    );
    expect(await readVaultFileRange(ctx, "upload/0.bin", 0, 3, 3)).toEqual(Buffer.from([1, 2, 3]));
    expect(await readdir(join(ctx.vaultRoot, "upload"))).toEqual(["0.bin"]);
  });
  it("requires a reservation, refuses changed geometry and checks exact retained length", async () => {
    await expect(publishReservedVaultFileBytes(ctx, "0", Buffer.from([1]))).rejects.toThrow();
    await reserveVaultFileBytes(ctx, "0", 2);
    await expect(reserveVaultFileBytes(ctx, "0", 1)).rejects.toThrow("size changed");
    await publishReservedVaultFileBytes(ctx, "0", Buffer.from([1, 2]));
    await expect(readVaultFileRange(ctx, "0", 0, 1, 1)).rejects.toThrow("exceeds file");
    await expect(reserveVaultFileBytes(ctx, ".", 1)).rejects.toBeInstanceOf(VaultPathError);
    await expect(reserveVaultFileBytes(ctx, "big", 1024 * 1024 + 1)).rejects.toThrow(RangeError);
  });
  it("contains both reservation and publication paths behind symlink guards", async () => {
    const outside = await mkdtemp(join(tmpdir(), "moss-reserved-outside-"));
    try {
      await symlink(outside, join(ctx.vaultRoot, "escape"));
      await expect(reserveVaultFileBytes(ctx, "escape/0", 1)).rejects.toBeInstanceOf(
        VaultPathError
      );
      await writeFile(join(outside, "0.reserved"), Buffer.from([1]));
      await expect(
        publishReservedVaultFileBytes(ctx, "escape/0", Buffer.from([2]))
      ).rejects.toBeInstanceOf(VaultPathError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
