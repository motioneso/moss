import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { VaultContext } from "./vault-context.js";
import { assertVaultContext } from "./vault-context.js";
import { VaultPathError, resolveVaultPath } from "./vault-path.js";

// Vault notes are private user data. Files are created 0600 (owner-only) and dirs 0700, so a
// shared host or a misconfigured umask can never leave a note world-readable.
const VAULT_FILE_MODE = 0o600;
const VAULT_DIR_MODE = 0o700;

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

async function assertNoSymlinkEscape(fullPath: string, vaultRoot: string): Promise<void> {
  // Walk up ancestor chain to find the deepest existing path, then realpath that.
  // Pre-write targets may have several non-existent ancestor segments.
  let checkPath = fullPath;
  let realChecked: string | undefined;
  while (checkPath !== dirname(checkPath)) {
    try {
      realChecked = await realpath(checkPath);
      break;
    } catch {
      checkPath = dirname(checkPath);
    }
  }
  if (realChecked === undefined) {
    realChecked = await realpath(checkPath);
  }
  const normalizedRoot = resolve(vaultRoot);
  if (realChecked !== normalizedRoot && !realChecked.startsWith(normalizedRoot + sep)) {
    throw new VaultPathError(relative(vaultRoot, fullPath));
  }
}

export async function readVaultFile(ctx: VaultContext, relativePath: string): Promise<string> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  return readFile(fullPath, "utf8");
}

export async function writeVaultFile(
  ctx: VaultContext,
  relativePath: string,
  content: string
): Promise<void> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  await mkdir(dirname(fullPath), { recursive: true, mode: VAULT_DIR_MODE });
  // `mode` on writeFile only applies when the file is created; chmod afterward guarantees
  // owner-only perms even when overwriting a note that predates this hardening.
  await writeFile(fullPath, content, { encoding: "utf8", mode: VAULT_FILE_MODE });
  await chmod(fullPath, VAULT_FILE_MODE);
}

// #1133 — byte variants for chat attachments (images/PDFs). Same containment discipline as
// the string helpers (resolveVaultPath + assertNoSymlinkEscape + 0600/0700); only the
// encoding differs: Buffers in/out so binary content is never corrupted by a utf8 decode.
export async function readVaultFileBytes(ctx: VaultContext, relativePath: string): Promise<Buffer> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  return readFile(fullPath);
}

export async function writeVaultFileBytes(
  ctx: VaultContext,
  relativePath: string,
  content: Buffer
): Promise<void> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  await mkdir(dirname(fullPath), { recursive: true, mode: VAULT_DIR_MODE });
  // chmod after write for the same overwrite-hardening reason as writeVaultFile.
  await writeFile(fullPath, content, { mode: VAULT_FILE_MODE });
  await chmod(fullPath, VAULT_FILE_MODE);
}

export async function listVaultFiles(ctx: VaultContext, relativeDir: string): Promise<string[]> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  const entries = await readdir(fullPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}

export interface VaultDirectoryEntry {
  readonly name: string;
  readonly path: string;
}

export async function listVaultDirectories(
  ctx: VaultContext,
  relativeDir: string = "."
): Promise<VaultDirectoryEntry[]> {
  assertVaultContext(ctx);
  if (isAbsolute(relativeDir) || relativeDir.split(/[\\/]/).includes("..")) {
    throw new VaultPathError(relativeDir);
  }
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  const entries = await readdir(fullPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: relative(ctx.vaultRoot, join(fullPath, entry.name)) || "."
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteVaultFile(ctx: VaultContext, relativePath: string): Promise<void> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  await rm(fullPath);
}

/**
 * #1133 — recursive delete of a directory INSIDE the vault (e.g. one attachment's
 * `attachments/<id>/` folder during lazy GC). Refuses the vault root itself so a bug can
 * never wipe a whole vault through this path; account deletion uses deleteUserVaultDir.
 * Idempotent (`force: true`) because GC may race a concurrent sweep.
 */
export async function deleteVaultDir(ctx: VaultContext, relativeDir: string): Promise<void> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  if (resolve(fullPath) === resolve(ctx.vaultRoot)) {
    throw new VaultPathError(relativeDir);
  }
  await rm(fullPath, { recursive: true, force: true });
}

export async function vaultFileExists(ctx: VaultContext, relativePath: string): Promise<boolean> {
  assertVaultContext(ctx);
  // resolveVaultPath + assertNoSymlinkEscape outside the try so their errors propagate
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativePath);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  try {
    await stat(fullPath);
    return true;
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    return false;
  }
}

export async function makeVaultDir(ctx: VaultContext, relativeDir: string): Promise<void> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  await mkdir(fullPath, { recursive: true, mode: VAULT_DIR_MODE });
}

async function collectFilesRecursive(dir: string, vaultRoot: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFilesRecursive(entryPath, vaultRoot)));
    } else if (entry.isFile()) {
      result.push(relative(vaultRoot, entryPath));
    }
  }
  return result;
}

export async function listVaultFilesRecursive(
  ctx: VaultContext,
  relativeDir: string = "."
): Promise<string[]> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, relativeDir);
  await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
  return collectFilesRecursive(fullPath, ctx.vaultRoot);
}

/**
 * Operator-level helper: removes the entire vault directory for a given userId.
 *
 * This is intentionally NOT scoped to a VaultContext (which belongs to a live
 * user session) — it is called during account deletion after the DB transaction
 * has committed. It is idempotent: no error is thrown if the directory does not
 * exist. The resolved path is checked to be strictly inside `vaultsBaseDir`
 * before deletion to prevent path traversal.
 *
 * Ordering rationale: call AFTER the DB commit. If the DB delete fails the
 * vault is untouched; if the vault rm fails the DB rows are already gone (the
 * user is effectively deleted) and the orphan can be retried or cleaned up
 * manually without risk of data inconsistency.
 */
export async function deleteUserVaultDir(vaultsBaseDir: string, userId: string): Promise<void> {
  const normalizedBase = resolve(vaultsBaseDir);
  const userVaultDir = resolve(join(vaultsBaseDir, userId));

  // Safety check: the resolved path must be strictly inside the base dir.
  // This mirrors the containment logic in resolveVaultPath.
  if (userVaultDir === normalizedBase || !userVaultDir.startsWith(normalizedBase + sep)) {
    throw new Error(
      `deleteUserVaultDir: resolved path ${JSON.stringify(userVaultDir)} is not inside vault base ${JSON.stringify(normalizedBase)}`
    );
  }

  await rm(userVaultDir, { recursive: true, force: true });
}

/**
 * Operator-level helper: lists every owner's vault directory name under
 * `vaultsBaseDir` (each is a userId). Like `deleteUserVaultDir`, intentionally
 * NOT scoped to a VaultContext — used by the vault-ingest scheduler tick to
 * enumerate owners for fan-out, not by a live user session. Returns an empty
 * list (not an error) if the base dir does not exist yet.
 */
export async function listVaultOwnerIds(vaultsBaseDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(vaultsBaseDir, { withFileTypes: true });
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
