import { assertDataContextDb, isUuid } from "@moss/db";
import type { RouteChatTargetResolver } from "@moss/module-sdk";

/** #3065: task lists and tags have owner-only RLS; query through the supplied actor context. */
export const taskListTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const id = params.listId;
  if (!id || !isUuid(id)) return null;
  const row = await db.db
    .selectFrom("app.task_lists")
    .select("name")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.name ?? null;
};

export const taskTagTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const { listId, tagId } = params;
  if (!listId || !tagId || !isUuid(listId) || !isUuid(tagId)) return null;
  const row = await db.db
    .selectFrom("app.task_tags")
    .select("name")
    .where("id", "=", tagId)
    .where("list_id", "=", listId)
    .executeTakeFirst();
  return row?.name ?? null;
};

/** Assignment RLS requires parent-task ownership, rather than the task's broader read shares. */
export const taskTagAssignmentTarget: RouteChatTargetResolver = async (db, params) => {
  assertDataContextDb(db);
  const { id, tagId } = params;
  if (!id || !tagId || !isUuid(id) || !isUuid(tagId)) return null;
  const row = await db.db
    .selectFrom("app.task_tag_assignments as a")
    .innerJoin("app.tasks as t", "t.id", "a.task_id")
    .innerJoin("app.task_tags as g", "g.id", "a.tag_id")
    .select(["g.name", "t.title"])
    .where("a.task_id", "=", id)
    .where("a.tag_id", "=", tagId)
    .executeTakeFirst();
  return row ? `${row.name} on ${row.title}` : null;
};
