import { sql } from "kysely";

import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";

/** Identify the actor's note for deletion without reading its body or linked health details. */
export const therapyNoteTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.wellness_therapy_notes")
    .select("created_at")
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  return row ? `Therapy note from ${row.created_at.toISOString()}` : null;
};
