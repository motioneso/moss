import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import type { AccessContext } from "@moss/db";

export class VaultContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultContextError";
  }
}

export const vaultContextBrand: unique symbol = Symbol("VaultContext");

export interface VaultContext {
  readonly [vaultContextBrand]: true;
  readonly actorUserId: string;
  readonly vaultRoot: string;
}

export function assertVaultContext(value: unknown): asserts value is VaultContext {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<VaultContext>)[vaultContextBrand] !== true
  ) {
    throw new Error("Vault file access requires withVaultContext");
  }
}

export class VaultContextRunner {
  constructor(private readonly vaultsBaseDir: string) {}

  async withVaultContext<T>(
    accessContext: AccessContext,
    work: (ctx: VaultContext) => Promise<T>
  ): Promise<T> {
    if (!accessContext.actorUserId || !accessContext.actorUserId.trim()) {
      throw new VaultContextError("withVaultContext: actorUserId must be non-empty");
    }
    const vaultRoot = join(this.vaultsBaseDir, accessContext.actorUserId);
    await mkdir(vaultRoot, { recursive: true, mode: 0o700 });

    return work({
      [vaultContextBrand]: true,
      actorUserId: accessContext.actorUserId,
      vaultRoot
    });
  }

  /**
   * #2268 — opens a context rooted at a caller-supplied absolute folder instead of the private
   * per-user vault, so a module (People) can read and write notes inside the user's own notes
   * tree while still going through VaultContext rather than raw `fs`.
   *
   * The root is subject to exactly the check the notes worker applies to `notes-source-path`:
   * `realpath` it, then require the resolved path to sit inside one of `allowedRoots`. Storing
   * the resolved path as `vaultRoot` (not the raw input) means every vault op's symlink-escape
   * guard compares against the real directory, so a symlink pointing out of the folder is still
   * refused. Unlike the private root this never creates the directory — a root that does not
   * exist is a refusal, not something to silently conjure.
   */
  async withVaultContextAt<T>(
    accessContext: AccessContext,
    absoluteRoot: string,
    allowedRoots: readonly string[],
    work: (ctx: VaultContext) => Promise<T>
  ): Promise<T> {
    if (!accessContext.actorUserId || !accessContext.actorUserId.trim()) {
      throw new VaultContextError("withVaultContextAt: actorUserId must be non-empty");
    }
    if (!absoluteRoot || !isAbsolute(absoluteRoot)) {
      throw new VaultContextError("withVaultContextAt: root must be an absolute path");
    }

    const resolvedAllowed: string[] = [];
    for (const root of allowedRoots) {
      if (!root || !isAbsolute(root)) continue;
      try {
        resolvedAllowed.push(await realpath(root));
      } catch {
        // A configured root that is not mounted on this host cannot contain anything.
      }
    }
    if (resolvedAllowed.length === 0) {
      throw new VaultContextError("withVaultContextAt: no allowed roots are available");
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(absoluteRoot);
    } catch {
      throw new VaultContextError("withVaultContextAt: root does not exist");
    }

    const isWithinAllowed = resolvedAllowed.some(
      (root) => resolvedRoot === root || resolvedRoot.startsWith(root + sep)
    );
    if (!isWithinAllowed) {
      throw new VaultContextError("withVaultContextAt: root is not within an allowed root");
    }

    return work({
      [vaultContextBrand]: true,
      actorUserId: accessContext.actorUserId,
      vaultRoot: resolvedRoot
    });
  }
}
