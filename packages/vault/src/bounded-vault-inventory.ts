import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { assertVaultContext, type VaultContext } from "./vault-context.js";
import { canonicalizeAsFarAsExists } from "./vault-canonical-path.js";
import { resolveVaultPath } from "./vault-path.js";
import { assertNoSymlinkEscape } from "./vault-ops.js";

export interface VaultInventoryEntry {
  readonly path: string;
  readonly kind: "directory" | "markdown";
  readonly excerpt: string | null;
}
export type VaultInventoryResult =
  | {
      readonly entries: readonly VaultInventoryEntry[];
      readonly status: "complete";
    }
  | {
      readonly entries: readonly VaultInventoryEntry[];
      readonly status: "overflow";
      readonly limit: "entries" | "serialized_bytes" | "path_bytes" | "depth" | "scanned_entries";
    };

const MAX_ENTRIES = 200;
const MAX_PATH_BYTES = 512;
const MAX_EXCERPT_BYTES = 2048;
const MAX_SERIALIZED_BYTES = 256 * 1024;
const MAX_DEPTH = 16;
const MAX_SCANNED_ENTRIES = 8192;

/**
 * A bounded capability read. This does not follow directory entries which are symlinks and
 * does not claim atomicity against external edits. Owning services revalidate destinations
 * and read exact current bytes under their mutation lock before accepting changes.
 */
export async function readBoundedVaultInventory(ctx: VaultContext): Promise<VaultInventoryResult> {
  assertVaultContext(ctx);
  const root = await canonicalizeAsFarAsExists(ctx.vaultRoot);
  const entries: VaultInventoryEntry[] = [{ path: ".", kind: "directory", excerpt: null }];
  let serializedBytes = Buffer.byteLength(JSON.stringify(entries), "utf8");
  const pending = [{ path: ".", depth: 0 }];
  let scanned = 0;
  const overflow = (
    limit: Extract<VaultInventoryResult, { status: "overflow" }>["limit"]
  ): VaultInventoryResult => ({
    entries,
    status: "overflow",
    limit
  });
  while (pending.length) {
    const directory = pending.pop()!;
    const absolute = resolveVaultPath(root, directory.path);
    await assertNoSymlinkEscape(absolute, root);
    for await (const entry of await opendir(absolute)) {
      if (++scanned > MAX_SCANNED_ENTRIES) return overflow("scanned_entries");
      const isDirectory = entry.isDirectory();
      const isMarkdown = entry.isFile() && entry.name.toLowerCase().endsWith(".md");
      if (!isDirectory && !isMarkdown) continue;
      const path = join(directory.path, entry.name);
      if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return overflow("path_bytes");
      if (entries.length === MAX_ENTRIES) return overflow("entries");
      if (isDirectory && directory.depth === MAX_DEPTH) return overflow("depth");
      const candidate: VaultInventoryEntry = {
        path,
        kind: isDirectory ? "directory" : "markdown",
        excerpt: isDirectory ? null : await readPrefix(root, path)
      };
      const nextBytes = serializedBytes + 1 + Buffer.byteLength(JSON.stringify(candidate), "utf8");
      // Reserve space for result metadata even on overflow.
      if (nextBytes > MAX_SERIALIZED_BYTES - 256) return overflow("serialized_bytes");
      entries.push(candidate);
      serializedBytes = nextBytes;
      if (isDirectory) pending.push({ path, depth: directory.depth + 1 });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, status: "complete" };
}

async function readPrefix(root: string, path: string): Promise<string> {
  const absolute = resolveVaultPath(root, path);
  await assertNoSymlinkEscape(absolute, root);
  const handle = await open(absolute, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Vault inventory target is not a file");
    const bytes = Buffer.alloc(MAX_EXCERPT_BYTES);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    // A streaming decode leaves a partial final codepoint buffered instead of inventing U+FFFD.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset), {
      stream: stats.size > offset
    });
  } finally {
    await handle.close();
  }
}
