import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";
import { sql } from "kysely";

/** Read the exact owner's meeting title, never its notes or transcript. */
export const meetingRecordTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.id;
  if (!id || !isUuid(id)) return null;
  const record = await db.db
    .selectFrom("app.meeting_records")
    .select("title")
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  return record?.title ?? null;
};
