import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";
import { sql } from "kysely";

/** Admin status never widens this lookup beyond the actor's own project. */
export const workshopProjectTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.projectId;
  if (!id || !isUuid(id)) return null;
  const project = await db.db
    .selectFrom("app.workshop_projects")
    .select("title")
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .executeTakeFirst();
  return project?.title ?? null;
};
