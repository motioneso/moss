import { link, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertVaultContext, type VaultContext } from "./vault-context.js";
import { resolveVaultPath, VaultPathError } from "./vault-path.js";
import { assertNoSymlinkEscape, syncPath, VAULT_READ_RANGE_LIMIT } from "./vault-ops.js";

function isCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}
async function paths(ctx: VaultContext, relativePath: string, length: number) {
  assertVaultContext(ctx);
  if (!Number.isSafeInteger(length) || length < 1 || length > VAULT_READ_RANGE_LIMIT)
    throw new RangeError("Invalid vault reservation size");
  const final = resolveVaultPath(ctx.vaultRoot, relativePath);
  if (final === resolve(ctx.vaultRoot)) throw new VaultPathError(relativePath);
  const pending = `${final}.reserved`;
  await assertNoSymlinkEscape(final, ctx.vaultRoot);
  await assertNoSymlinkEscape(pending, ctx.vaultRoot);
  return { final, pending };
}
async function exists(path: string, length: number) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size !== length) throw new Error("Vault reservation size changed");
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}
async function syncDirectories(ctx: VaultContext, path: string) {
  let directory = dirname(path);
  while (directory !== resolve(ctx.vaultRoot)) {
    await syncPath(directory);
    directory = dirname(directory);
  }
  await syncPath(directory);
  await syncPath(dirname(directory));
}

/**
 * Allocate real blocks with bounded zero writes, never sparse truncate. The caller
 * MUST serialize reserve/publish/delete for this path (e.g. a durable row lock).
 * An interrupted allocation can be resumed; directory expiry removes abandoned
 * reservations. A successful reservation is durable before the caller acknowledges.
 */
export async function reserveVaultFileBytes(ctx: VaultContext, path: string, length: number) {
  const { final, pending } = await paths(ctx, path, length);
  if (await exists(final, length)) return;
  await mkdir(dirname(final), { recursive: true, mode: 0o700 });
  const handle = await open(pending, "a+", 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > length) throw new Error("Vault reservation size changed");
    const zero = Buffer.alloc(Math.min(length, 64 * 1024));
    let position = info.size;
    while (position < length) {
      const { bytesWritten } = await handle.write(
        zero,
        0,
        Math.min(zero.length, length - position)
      );
      if (!bytesWritten) throw new Error("Vault allocation made no progress");
      position += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectories(ctx, final);
}

/** Publish into previously allocated blocks without a second full-size copy. */
export async function publishReservedVaultFileBytes(
  ctx: VaultContext,
  path: string,
  bytes: Buffer
) {
  const { final, pending } = await paths(ctx, path, bytes.length);
  if (await exists(final, bytes.length)) {
    // A process may have linked the inode and died before unlinking its private name.
    await rm(pending, { force: true });
    await syncDirectories(ctx, final);
    return "exists" as const;
  }
  const handle = await open(pending, "r+");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== bytes.length) throw new Error("Vault bytes not reserved");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("Vault publication made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await link(pending, final);
  await rm(pending);
  await syncDirectories(ctx, final);
  return "created" as const;
}
