import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { HeartbeatMute } from "@moss/shared";

export class HeartbeatMuteRepository {
  async list(scopedDb: DataContextDb): Promise<readonly HeartbeatMute[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.heartbeat_mutes")
      .select(["id", "label", "scope", "created_at"])
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      scope: row.scope,
      createdAt: row.created_at.toISOString()
    }));
  }

  /** True when a mute was removed. Another owner's mute is invisible under RLS and reads as absent. */
  async remove(scopedDb: DataContextDb, id: string): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .deleteFrom("app.heartbeat_mutes")
      .where("id", "=", id)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
