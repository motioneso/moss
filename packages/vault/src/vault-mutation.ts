import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { assertDataContextDb, readScopedActorUserId, type DataContextDb } from "@moss/db";
import { sql } from "kysely";

import { canonicalizeAsFarAsExists } from "./vault-canonical-path.js";
import { assertVaultContext, type VaultContext } from "./vault-context.js";
import { syncPath } from "./vault-ops.js";
import { resolveVaultPath, VaultPathError } from "./vault-path.js";

export interface VaultMutationSnapshot {
  readonly path: string;
  readonly canonicalPath: string;
  readonly content: string | null;
  readonly revision: string | null;
}

export interface VaultMutationChange {
  readonly path: string;
  /** null removes the file; an empty string writes an empty file. */
  readonly content: string | null;
}

export class VaultMutationConflictError extends Error {
  constructor() {
    super("Vault file changed during mutation; read the current file and retry");
    this.name = "VaultMutationConflictError";
  }
}

/**
 * Serialize participating API/worker writers by physical pathname, across actors and aliases.
 * The caller owns the DataContext transaction; destination locks last until its commit/rollback.
 * Acquire actor/source admission before entering this operation when working on managed sources.
 * The transform must be bounded local work, without provider calls or another DataContext.
 * Each file is published atomically, but a multi-file plan is not an atomic batch. Completed
 * external edits are compared before publication; this is not CAS against arbitrary editors or
 * protection against hostile concurrent ancestor replacement. DB rollback cannot roll back files.
 */
export async function mutateVaultFiles<T>(
  db: DataContextDb,
  ctx: VaultContext,
  paths: readonly string[],
  transform: (
    current: readonly VaultMutationSnapshot[]
  ) => Promise<{ readonly changes: readonly VaultMutationChange[]; readonly result: T }>
): Promise<T> {
  assertDataContextDb(db);
  assertVaultContext(ctx);
  if ((await readScopedActorUserId(db))?.toLowerCase() !== ctx.actorUserId.toLowerCase()) {
    throw new Error("Vault mutation requires the scoped actor's VaultContext");
  }
  if (paths.length < 1 || paths.length > 32 || new Set(paths).size !== paths.length) {
    throw new Error("Vault mutation requires 1 to 32 distinct paths");
  }
  const root = await canonicalizeAsFarAsExists(ctx.vaultRoot);
  const targets = await Promise.all(
    paths.map(async (path) => ({ path, canonicalPath: await target(root, path) }))
  );
  const identities = targets.map(({ canonicalPath }) => canonicalPath);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Vault mutation paths must identify distinct files");
  }
  for (const identity of [...identities].sort()) {
    const key = createHash("sha256")
      .update("moss:vault-destination:v1\0")
      .update(identity)
      .digest()
      .readBigInt64BE()
      .toString();
    await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(db.db);
  }
  const snapshots: VaultMutationSnapshot[] = [];
  for (const item of targets) {
    await checkIdentity(root, item);
    const content = await readCurrent(item.canonicalPath);
    snapshots.push({ ...item, content, revision: revision(content) });
  }
  const plan = await transform(snapshots);
  const changes = new Set<string>();
  for (const change of plan.changes) {
    if (!paths.includes(change.path) || changes.has(change.path)) {
      throw new Error("Vault mutation may only change its declared paths once");
    }
    changes.add(change.path);
  }
  // Validate the complete plan before publishing its first file.
  for (const snapshot of snapshots) await compareCurrent(root, snapshot);
  for (const change of plan.changes) {
    const snapshot = snapshots.find(({ path }) => path === change.path)!;
    if (snapshot.content === change.content) continue;
    await publish(root, snapshot, change.content);
  }
  return plan.result;
}

async function target(root: string, path: string): Promise<string> {
  const absolute = resolveVaultPath(root, path);
  const canonical = await canonicalizeAsFarAsExists(absolute);
  if (canonical === root || !canonical.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new VaultPathError(path);
  return canonical;
}

async function checkIdentity(
  root: string,
  snapshot: Pick<VaultMutationSnapshot, "path" | "canonicalPath">
) {
  if ((await canonicalizeAsFarAsExists(root)) !== root) throw new VaultPathError(snapshot.path);
  if ((await target(root, snapshot.path)) !== snapshot.canonicalPath) {
    throw new VaultMutationConflictError();
  }
}

async function readCurrent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function revision(content: string | null): string | null {
  return content === null ? null : createHash("sha256").update(content).digest("hex");
}

async function compareCurrent(root: string, snapshot: VaultMutationSnapshot) {
  await checkIdentity(root, snapshot);
  if (revision(await readCurrent(snapshot.canonicalPath)) !== snapshot.revision) {
    throw new VaultMutationConflictError();
  }
  // readCurrent may yield to an external writer; recheck aliases before publication.
  await checkIdentity(root, snapshot);
}

async function publish(root: string, snapshot: VaultMutationSnapshot, content: string | null) {
  const destination = snapshot.canonicalPath;
  if (content === null) {
    await compareCurrent(root, snapshot);
    await unlink(destination);
    await syncPath(dirname(destination));
    return;
  }
  await checkIdentity(root, snapshot);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await checkIdentity(root, snapshot);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await syncPath(temporary);
    await compareCurrent(root, snapshot);
    if (snapshot.content === null) {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new VaultMutationConflictError();
        }
        throw error;
      }
    } else {
      await rename(temporary, destination);
    }
    let directory = dirname(destination);
    while (directory !== resolve(root)) {
      await syncPath(directory);
      directory = dirname(directory);
    }
    await syncPath(root);
    await syncPath(dirname(root));
  } finally {
    await rm(temporary, { force: true });
  }
}
