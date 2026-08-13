import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb, type Task } from "@moss/db";

/**
 * Repository for one-level task hierarchy and breakdown operations.
 *
 * Invariants:
 *  - Only top-level tasks (parent_task_id IS NULL) may be parents.
 *  - The DB trigger `tasks_hierarchy_guard` enforces this; we rely on it for
 *    grandchild rejection rather than duplicating the guard here.
 *  - Children inherit the parent's `list_id`.
 *  - Completion cascade (all siblings done → parent done) is handled in
 *    TasksRepository.update / updateStatus so activity is always recorded.
 */
export class TaskBreakdownRepository {
  /**
   * Break a parent task into ordered child steps.
   *
   * @param db     - Scoped data-context (RLS applied to current actor).
   * @param parentId - ID of the parent task.
   * @param steps  - Ordered array of child step titles.
   * @returns The created child Task rows (order matches `steps`).
   */
  async breakDown(db: DataContextDb, parentId: string, steps: string[]): Promise<Task[]> {
    assertDataContextDb(db);

    if (steps.length === 0) {
      return [];
    }

    // Look up the parent to inherit list_id. app.tasks RLS is owner-or-share, so a plain
    // visibility check would let a view-shared task from another owner become a breakdown
    // parent. Require owner_user_id = current_actor_user_id() explicitly (same guard as
    // TasksRepository.create()/update() for parentTaskId).
    const parent = await db.db
      .selectFrom("app.tasks")
      .select(["id", "list_id"])
      .where("id", "=", parentId)
      .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
      .executeTakeFirst();

    if (!parent) {
      throw new Error(`Parent task ${parentId} not found or not accessible`);
    }

    const now = new Date();

    // Insert each child in order. The DB trigger will reject grandchildren.
    const children: Task[] = [];
    for (let i = 0; i < steps.length; i++) {
      const child = await db.db
        .insertInto("app.tasks")
        .values({
          id: randomUUID(),
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          list_id: parent.list_id,
          parent_task_id: parentId,
          title: steps[i] as string,
          description: null,
          status: "todo",
          priority: null,
          position: i,
          due_at: null,
          do_at: null,
          effort: null,
          source: "manual",
          source_ref: null,
          external_key: null,
          recurrence: null,
          recurrence_series_id: null,
          completed_at: null,
          created_at: now,
          updated_at: now
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      children.push(child);
    }

    // Emit a broken_down activity on the parent.
    await db.db
      .insertInto("app.task_activity")
      .values({
        id: randomUUID(),
        task_id: parentId,
        actor_user_id: sql<string>`app.current_actor_user_id()`,
        actor_kind: "user" as const,
        activity_type: "broken_down",
        body: `Broken into ${steps.length} step${steps.length === 1 ? "" : "s"}`,
        created_at: now
      })
      .execute();

    return children;
  }
}
