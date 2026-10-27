import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { assertVaultContext, type VaultContext } from "./vault-context.js";
import { assertNoSymlinkEscape, createVaultFileBytes } from "./vault-ops.js";
import { resolveVaultPath } from "./vault-path.js";

const pending = new Map<string, Promise<unknown>>();

/** Compare the current bytes before appending, without rewriting the existing prefix.
 * Serializes callers in this process; external editors are checked immediately before append.
 * This is not a filesystem transaction with non-cooperating external writers.
 */
export async function appendVaultFileBytes(
  ctx: VaultContext,
  path: string,
  expected: Buffer | null,
  suffix: Buffer
): Promise<"written" | "changed"> {
  assertVaultContext(ctx);
  const fullPath = resolveVaultPath(ctx.vaultRoot, path);
  const previous = pending.get(fullPath) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      await assertNoSymlinkEscape(fullPath, ctx.vaultRoot);
      if (expected === null) {
        return (await createVaultFileBytes(ctx, path, suffix)) === "created"
          ? ("written" as const)
          : ("changed" as const);
      }
      const handle = await open(
        fullPath,
        constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW
      );
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new Error("Vault append requires a regular file");
        const content = await handle.readFile();
        if (!content.equals(expected)) return "changed" as const;
        const current = await lstat(fullPath);
        const after = await handle.stat();
        if (
          current.isSymbolicLink() ||
          current.ino !== before.ino ||
          current.dev !== before.dev ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs
        )
          return "changed" as const;
        await handle.writeFile(suffix);
        await handle.sync();
        return "written" as const;
      } finally {
        await handle.close();
      }
    });
  pending.set(fullPath, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(fullPath) === operation) pending.delete(fullPath);
  }
}
