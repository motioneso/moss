import { sql } from "kysely";

import type { DataContextDb } from "@moss/db";

export interface UserMemorySettings {
  readonly userId: string;
  readonly recallEnabled: boolean;
  readonly factsEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpdateMemorySettings {
  readonly recallEnabled?: boolean;
  readonly factsEnabled?: boolean;
}

const DEFAULTS: Omit<UserMemorySettings, "userId" | "createdAt" | "updatedAt"> = {
  recallEnabled: true,
  factsEnabled: true
};

export class ChatUserMemorySettingsRepository {
  async getOrCreate(scopedDb: DataContextDb, userId: string): Promise<UserMemorySettings> {
    type Row = {
      user_id: string;
      recall_enabled: boolean;
      facts_enabled: boolean;
      created_at: Date;
      updated_at: Date;
    };

    // Read first so an existing row is never locked; only a missing row is written.
    const existing = await sql<Row>`
      SELECT * FROM app.chat_user_memory_settings WHERE user_id = ${userId}::uuid
    `.execute(scopedDb.db);
    if (existing.rows[0]) return this.#mapRow(existing.rows[0]);

    await sql`
      INSERT INTO app.chat_user_memory_settings (user_id, recall_enabled, facts_enabled)
      VALUES (${userId}::uuid, ${DEFAULTS.recallEnabled}, ${DEFAULTS.factsEnabled})
      ON CONFLICT (user_id) DO NOTHING
    `.execute(scopedDb.db);
    const created = await sql<Row>`
      SELECT * FROM app.chat_user_memory_settings WHERE user_id = ${userId}::uuid
    `.execute(scopedDb.db);
    return this.#mapRow(created.rows[0]!);
  }

  async update(
    scopedDb: DataContextDb,
    userId: string,
    patch: UpdateMemorySettings
  ): Promise<UserMemorySettings> {
    const result = await sql<{
      user_id: string;
      recall_enabled: boolean;
      facts_enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>`
      INSERT INTO app.chat_user_memory_settings (user_id, recall_enabled, facts_enabled)
      VALUES (
        ${userId}::uuid,
        ${patch.recallEnabled ?? DEFAULTS.recallEnabled},
        ${patch.factsEnabled ?? DEFAULTS.factsEnabled}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        recall_enabled = COALESCE(${patch.recallEnabled ?? null}, app.chat_user_memory_settings.recall_enabled),
        facts_enabled  = COALESCE(${patch.factsEnabled ?? null}, app.chat_user_memory_settings.facts_enabled),
        updated_at     = now()
      RETURNING *
    `.execute(scopedDb.db);

    return this.#mapRow(result.rows[0]!);
  }

  #mapRow(r: {
    user_id: string;
    recall_enabled: boolean;
    facts_enabled: boolean;
    created_at: Date;
    updated_at: Date;
  }): UserMemorySettings {
    return {
      userId: r.user_id,
      recallEnabled: r.recall_enabled,
      factsEnabled: r.facts_enabled,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }
}
