import { createHash } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, assertUuid, type DataContextDb } from "./data-context.js";

export interface ManagedSourceKey {
  readonly ownerUserId: string;
  readonly sourceModuleId: string;
  readonly sourceId: string;
}

type LockMode = "shared" | "exclusive";

/** Locks last until the scoped transaction ends. Call actor, sources, then destinations. */
export async function lockManagedActor(
  db: DataContextDb,
  actorUserId: string,
  mode: LockMode
): Promise<void> {
  assertUuid(actorUserId, "Managed actor");
  await lock(db, ["actor", actorUserId.toLowerCase()], mode);
}

export async function lockManagedSources(
  db: DataContextDb,
  sources: readonly ManagedSourceKey[],
  mode: LockMode
): Promise<void> {
  assertDataContextDb(db);
  if (mode !== "shared" && mode !== "exclusive") throw new Error("Invalid admission lock mode");
  const keys = sources.map((source) => {
    assertUuid(source.ownerUserId, "Managed source owner");
    assertUuid(source.sourceId, "Managed source ID");
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(source.sourceModuleId)) {
      throw new Error("Invalid managed source module ID");
    }
    return JSON.stringify([
      "source",
      source.ownerUserId.toLowerCase(),
      source.sourceModuleId,
      source.sourceId.toLowerCase()
    ]);
  });
  for (const key of [...new Set(keys)].sort()) await lock(db, key, mode);
}

async function lock(db: DataContextDb, identity: string | readonly string[], mode: LockMode) {
  assertDataContextDb(db);
  if (mode !== "shared" && mode !== "exclusive") throw new Error("Invalid admission lock mode");
  const key = createHash("sha256")
    .update("moss:managed-admission:v1\0")
    .update(typeof identity === "string" ? identity : JSON.stringify(identity))
    .digest()
    .readBigInt64BE()
    .toString();
  if (mode === "shared") {
    await sql`select pg_advisory_xact_lock_shared(${key}::bigint)`.execute(db.db);
  } else {
    await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(db.db);
  }
}
