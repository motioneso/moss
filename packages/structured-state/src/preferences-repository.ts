import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";

function jsonb(value: unknown) {
  return sql<Record<string, unknown>>`${JSON.stringify(value)}::jsonb`;
}

export class PreferenceRevisionConflictError extends Error {
  constructor(public readonly key: string) {
    super(`Preference "${key}" was modified concurrently`);
    this.name = "PreferenceRevisionConflictError";
  }
}

export class PreferencesRepository {
  async upsert(scopedDb: DataContextDb, key: string, value: unknown): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.preferences")
      .values({
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        key,
        value_json: jsonb(value),
        updated_at: new Date()
      })
      .onConflict((oc) =>
        oc.columns(["owner_user_id", "key"]).doUpdateSet({
          value_json: jsonb(value),
          // Plain upsert() and CAS upsertWithRevision() write the same column; without this bump
          // a plain writer (e.g. a REST route) silently defeats every CAS reader's revision check.
          revision: sql<number>`app.preferences.revision + 1`,
          updated_at: new Date()
        })
      )
      .execute();
  }

  async get(scopedDb: DataContextDb, key: string): Promise<unknown> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.preferences")
      .select("value_json")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.value_json ?? null;
  }

  async getWithMetadata<T>(
    scopedDb: DataContextDb,
    key: string
  ): Promise<{ value: T; updatedAt: Date } | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.preferences")
      .select(["value_json", "updated_at"])
      .where("key", "=", key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      value: row.value_json as T,
      updatedAt: row.updated_at
    };
  }

  async list(scopedDb: DataContextDb): Promise<Record<string, unknown>> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.preferences")
      .select(["key", "value_json"])
      .execute();
    return Object.fromEntries(rows.map((r) => [r.key, r.value_json]));
  }

  async delete(scopedDb: DataContextDb, key: string): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db.deleteFrom("app.preferences").where("key", "=", key).execute();
  }

  // Keep in step with the proactive-monitoring preferences repository's upsertWithRevision.
  async upsertWithRevision(
    scopedDb: DataContextDb,
    key: string,
    value: unknown,
    expectedRevision: number | null
  ): Promise<{ revision: number }> {
    assertDataContextDb(scopedDb);
    if (expectedRevision === null) {
      const row = await scopedDb.db
        .insertInto("app.preferences")
        .values({
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          key,
          value_json: jsonb(value),
          revision: 1,
          updated_at: new Date()
        })
        .onConflict((oc) => oc.columns(["owner_user_id", "key"]).doNothing())
        .returning("revision")
        .executeTakeFirst();
      if (!row) throw new PreferenceRevisionConflictError(key);
      return { revision: row.revision };
    }
    const row = await scopedDb.db
      .updateTable("app.preferences")
      .set({ value_json: jsonb(value), revision: expectedRevision + 1, updated_at: new Date() })
      .where("key", "=", key)
      .where("revision", "=", expectedRevision)
      .returning("revision")
      .executeTakeFirst();
    if (!row) throw new PreferenceRevisionConflictError(key);
    return { revision: row.revision };
  }

  // CAS delete — used by undo when the tracked mutation created a row that didn't exist before
  // (absent-row case): undo removes the row instead of upserting the prior default back in.
  async deleteWithRevision(
    scopedDb: DataContextDb,
    key: string,
    expectedRevision: number
  ): Promise<void> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .deleteFrom("app.preferences")
      .where("key", "=", key)
      .where("revision", "=", expectedRevision)
      .returning("revision")
      .executeTakeFirst();
    if (!row) throw new PreferenceRevisionConflictError(key);
  }

  // Revision plus updated_at for writers whose callers hold an opaque version token. forUpdate
  // locks the row so a concurrent delete/recreate cannot slip between the check and the CAS write.
  async getVersioned(
    scopedDb: DataContextDb,
    key: string,
    options: { forUpdate?: boolean } = {}
  ): Promise<{ value: unknown; revision: number; updatedAt: Date } | null> {
    assertDataContextDb(scopedDb);
    let query = scopedDb.db
      .selectFrom("app.preferences")
      .select(["value_json", "revision", "updated_at"])
      .where("key", "=", key);
    if (options.forUpdate) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    return row
      ? { value: row.value_json, revision: row.revision, updatedAt: row.updated_at }
      : null;
  }

  async getWithRevision(
    scopedDb: DataContextDb,
    key: string
  ): Promise<{ value: unknown; revision: number } | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.preferences")
      .select(["value_json", "revision"])
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? { value: row.value_json, revision: row.revision } : null;
  }
}
