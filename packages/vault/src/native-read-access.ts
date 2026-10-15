import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { assertVaultContext, type VaultContext } from "./vault-context.js";

const run = promisify(execFile);
const MAX_ENTRIES = 10_000;

/** Metadata-only bridge from a private app-owned vault to its owner's isolated CLI account.
 * Run AS the app account with no capabilities. Never follows links or reads file contents.
 * The app service is the trusted writer; this does not isolate a hostile same-UID app process.
 */
export async function grantVaultNativeReadAccess(ctx: VaultContext, uid: number): Promise<void> {
  assertVaultContext(ctx);
  if (!Number.isSafeInteger(uid) || uid < 100_001 || uid > 101_000) {
    throw new Error("Native vault access requires a stable person UID slot");
  }
  const root = resolve(ctx.vaultRoot);
  for (let path = root; ; path = dirname(path)) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Linked vault ancestor");
    if (path === dirname(path)) break;
  }
  const entries: { path: string; directory: boolean; ino: number; dev: number }[] = [];
  async function collect(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if ((!info.isFile() && !info.isDirectory()) || info.uid !== process.getuid?.()) {
      throw new Error("Unexpected vault entry ownership or type");
    }
    if (info.isFile() && info.nlink !== 1) throw new Error("Hardlinked vault file");
    if (entries.length >= MAX_ENTRIES) throw new Error("Native vault entry limit exceeded");
    entries.push({ path, directory: info.isDirectory(), ino: info.ino, dev: info.dev });
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await collect(join(path, name));
    }
  }
  await collect(root);
  // Validate every ACL before changing any mask. Otherwise mask recomputation could activate
  // another account's previously masked rights. No foreign named user/group or default ACL.
  for (const entry of entries) {
    const { stdout } = await run("getfacl", ["-ncp", "--", entry.path]);
    for (const line of stdout.trim().split("\n")) {
      const rule = line.split(/\s+#/)[0]!;
      if (
        !/^user::[rwx-]{3}$/.test(rule) &&
        !new RegExp(`^user:${uid}:[rwx-]{3}$`).test(rule) &&
        rule !== "group::---" &&
        rule !== "other::---" &&
        !/^mask::[rwx-]{3}$/.test(rule)
      )
        throw new Error("Unexpected vault ACL; refusing to widen its mask");
    }
  }
  for (const entry of entries) {
    const info = await lstat(entry.path);
    if (
      info.ino !== entry.ino ||
      info.dev !== entry.dev ||
      info.isSymbolicLink() ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new Error("Vault entry changed during preparation");
    const permission = entry.directory ? "r-x" : "r--";
    await run("setfacl", ["-P", "-m", `u:${uid}:${permission},m::${permission}`, "--", entry.path]);
  }
  // The shared parent permits traversal only. --no-mask preserves all existing ACL effectiveness.
  await run("setfacl", ["-P", "-n", "-m", `u:${uid}:--x`, "--", dirname(root)]);
}
