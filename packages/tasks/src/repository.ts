import { randomUUID } from "node:crypto";

import { sql, type Updateable } from "kysely";

import {
  assertDataContextDb,
  type DataContextDb,
  type Task,
  type TaskActivity,
  type TaskStatus,
  type TaskTag,
  type TasksTable
} from "@moss/db";
import { localDay, type TaskSuggestionMetadataV1 } from "@moss/shared";

import { HttpError } from "./errors.js";
import {
  TASK_IMPORTANT_PRIORITY_MIN,
  TASK_QUADRANT_AXES,
  TASK_URGENCY_WINDOW_MS,
  type TaskQuadrant
} from "./classification.js";
import { readActorTimezone } from "./drift.js";
import { TaskListsRepository } from "./lists.js";
import { generateNext, rollForwardOwnedSeries, type RecurrenceSpec } from "./recurrence.js";

export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly priority?: number | null;
  readonly dueAt?: Date | string | null;
  readonly listId?: string;
  readonly doAt?: Date | string | null;
  readonly effort?: "quick" | "medium" | "large" | null;
  readonly parentTaskId?: string | null;
  readonly source?: string;
  readonly sourceRef?: string | null;
  readonly externalKey?: string | null;
  readonly recurrence?: RecurrenceSpec | null;
  readonly suggestionMetadata?: TaskSuggestionMetadataV1 | null;
}

export interface UpdateTaskInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly priority?: number | null;
  readonly dueAt?: Date | string | null;
  readonly listId?: string;
  readonly doAt?: Date | string | null;
  readonly effort?: "quick" | "medium" | "large" | null;
  readonly parentTaskId?: string | null;
  readonly recurrence?: RecurrenceSpec | null;
}

export interface AddTaskActivityInput {
  readonly activityType: string;
  readonly body?: string | null;
}

export interface ListTasksCriteria {
  readonly listId?: string;
  readonly tagId?: string;
  readonly status?: TaskStatus;
  readonly priority?: number;
  readonly dueBefore?: Date;
  readonly dueAfter?: Date;
  readonly completedAfter?: Date;
  readonly quadrant?: TaskQuadrant;
  readonly now?: Date;
}

export class TasksRepository {
  private readonly listsRepository = new TaskListsRepository();

  async listVisible(scopedDb: DataContextDb): Promise<Task[]> {
    assertDataContextDb(scopedDb);

    // Lazy-on-view freshness: advance any stale recurring series before reading so the
    // list reflects the current occurrence between daily cron ticks. No-op when nothing
    // is stale. Owner-only (RLS + explicit owner predicate inside rollForwardOwnedSeries).
    //
    // #877 finding 2: this is the exact "safety net" the recurrence-schedule.ts comment
    // used to (wrongly) claim kept the list correct regardless of local midnight — it
    // couldn't while `today` defaulted to the server's UTC day. Read the actor's tz first
    // and roll on THEIR local day instead.
    const listVisibleTz = await readActorTimezone(scopedDb);
    await rollForwardOwnedSeries(scopedDb, localDay(new Date(), listVisibleTz));

    return scopedDb.db
      .selectFrom("app.tasks")
      .selectAll()
      .orderBy("updated_at", "desc")
      .orderBy("id")
      .execute();
  }

  async listFiltered(scopedDb: DataContextDb, criteria: ListTasksCriteria = {}): Promise<Task[]> {
    assertDataContextDb(scopedDb);

    // Same lazy-on-view safety net as listVisible above — roll forward on the actor's
    // local day, not the server's UTC day (#877 finding 2).
    const listFilteredTz = await readActorTimezone(scopedDb);
    await rollForwardOwnedSeries(scopedDb, localDay(new Date(), listFilteredTz));

    let query = scopedDb.db
      .selectFrom("app.tasks as t")
      .selectAll("t")
      .orderBy("t.updated_at", "desc")
      .orderBy("t.id");

    if (criteria.listId !== undefined) {
      query = query.where("t.list_id", "=", criteria.listId);
    }
    if (criteria.status !== undefined) {
      query = query.where("t.status", "=", criteria.status);
    }
    if (criteria.priority !== undefined) {
      query = query.where("t.priority", "=", criteria.priority);
    }
    if (criteria.dueBefore !== undefined) {
      query = query.where("t.due_at", "is not", null).where("t.due_at", "<", criteria.dueBefore);
    }
    if (criteria.dueAfter !== undefined) {
      query = query.where("t.due_at", "is not", null).where("t.due_at", ">", criteria.dueAfter);
    }
    if (criteria.completedAfter !== undefined) {
      query = query
        .where("t.completed_at", "is not", null)
        .where("t.completed_at", ">", criteria.completedAfter);
    }
    if (criteria.tagId !== undefined) {
      const tagId = criteria.tagId;
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom("app.task_tag_assignments as a")
            .select(sql<number>`1`.as("one"))
            .whereRef("a.task_id", "=", "t.id")
            .where("a.tag_id", "=", tagId)
        )
      );
    }
    if (criteria.quadrant !== undefined) {
      const urgentBefore = new Date(
        (criteria.now ?? new Date()).getTime() + TASK_URGENCY_WINDOW_MS
      );
      // Derive the predicate from the single shared quadrant matrix + threshold, so
      // the SQL filter cannot drift from the in-memory mirror. Each axis is expressed
      // once here (TASK_QUADRANT_AXES / TASK_IMPORTANT_PRIORITY_MIN /
      // TASK_URGENCY_WINDOW_MS, re-exported via ./classification.js from @moss/shared);
      // the frontend's equivalent classifier is `quadrantOf` in @moss/shared.
      const axes = TASK_QUADRANT_AXES[criteria.quadrant];
      const importantExpr = axes.important
        ? sql<boolean>`t.priority is not null and t.priority >= ${TASK_IMPORTANT_PRIORITY_MIN}`
        : sql<boolean>`(t.priority is null or t.priority < ${TASK_IMPORTANT_PRIORITY_MIN})`;
      const urgentExpr = axes.urgent
        ? sql<boolean>`t.due_at is not null and t.due_at <= ${urgentBefore}`
        : sql<boolean>`(t.due_at is null or t.due_at > ${urgentBefore})`;
      query = query.where(importantExpr).where(urgentExpr);
    }

    return query.execute();
  }

  async getById(scopedDb: DataContextDb, taskId: string): Promise<Task | undefined> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.tasks")
      .selectAll()
      .where("id", "=", taskId)
      .executeTakeFirst();
  }

  /**
   * True iff the current actor OWNS at least one task in a recurrence series. RLS scopes the
   * read to the actor, and the explicit owner predicate keeps a merely-shared recurring series
   * (tasks_select is owner-OR-share) from counting. Used to gate the per-session schedule
   * self-heal in GET /api/tasks/lists so non-recurrence users never open a pg-boss schedule
   * upsert. Cheap: a single LIMIT 1 existence probe in the same RLS transaction as the lists read.
   */
  async hasRecurringSeries(scopedDb: DataContextDb): Promise<boolean> {
    assertDataContextDb(scopedDb);

    const row = await scopedDb.db
      .selectFrom("app.tasks")
      .select(sql<number>`1`.as("one"))
      .where("recurrence_series_id", "is not", null)
      .where(sql<boolean>`owner_user_id = app.current_actor_user_id()`)
      .limit(1)
      .executeTakeFirst();

    return row != null;
  }

  async create(scopedDb: DataContextDb, input: CreateTaskInput): Promise<Task> {
    assertDataContextDb(scopedDb);

    const source = input.source ?? "manual";

    // Idempotency: when externalKey is provided, check if a matching task already exists
    // for this (source, external_key) pair, scoped to the current actor's own rows.
    // tasks_select RLS is owner-OR-share, so an explicit owner filter is required here — relying
    // on RLS alone would let a shared task from another owner read as "this actor's existing row"
    // and skip creating the actor's own copy (#1055). The unique index
    // tasks_source_external_key_idx (owner_user_id, source, external_key) already scopes
    // uniqueness per-owner, confirming per-owner idempotency was always the schema's intent.
    if (input.externalKey != null) {
      const existing = await scopedDb.db
        .selectFrom("app.tasks")
        .selectAll()
        .where("source", "=", source)
        .where("external_key", "=", input.externalKey)
        .where(sql<boolean>`owner_user_id = app.current_actor_user_id()`)
        .executeTakeFirst();

      if (existing) {
        if (
          existing.status === "archived" &&
          input.status === "suggested" &&
          input.suggestionMetadata?.resurfaceReason != null
        ) {
          return scopedDb.db
            .updateTable("app.tasks")
            .set({
              title: input.title,
              description: input.description ?? null,
              status: "suggested",
              priority: input.priority ?? null,
              due_at: input.dueAt ?? null,
              source_ref: input.sourceRef ?? existing.source_ref,
              suggestion_metadata: input.suggestionMetadata as unknown as Record<string, unknown>,
              completed_at: null,
              updated_at: new Date()
            })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        if (existing.status === "suggested" && input.suggestionMetadata !== undefined) {
          return scopedDb.db
            .updateTable("app.tasks")
            .set({
              suggestion_metadata: input.suggestionMetadata as Record<string, unknown> | null,
              updated_at: new Date()
            })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        return existing;
      }
    }

    // Resolve list_id: use the provided listId or fall back to the actor's Personal list.
    // If a listId is provided, verify the actor owns it (RLS on task_lists is owner-only).
    if (input.listId) {
      const owned = await this.listsRepository.isOwnedByActor(scopedDb, input.listId);
      if (!owned) throw new HttpError(404, "List not found or not accessible");
    }
    // Verify ownership (not just visibility) for parentTaskId.
    // app.tasks RLS is owner-or-share, so a plain getById would succeed for view-shared tasks.
    // We require owner_user_id = current_actor_user_id() explicitly.
    if (input.parentTaskId != null) {
      const parentOwned = await scopedDb.db
        .selectFrom("app.tasks")
        .select("id")
        .where("id", "=", input.parentTaskId)
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .executeTakeFirst();
      if (!parentOwned) throw new HttpError(404, "Parent task not found or not accessible");
    }
    const listId = input.listId ?? (await this.listsRepository.getOrCreateDefault(scopedDb)).id;

    const now = new Date();
    const status = input.status ?? "todo";
    const completedAt = status === "done" ? now : null;

    // Recurrence specs are normalized at the route boundary by parseRecurrenceSpec.
    let recurrenceValue: RecurrenceSpec | null = null;
    let recurrenceSeriesId: string | null = null;
    if (input.recurrence != null) {
      recurrenceSeriesId = randomUUID();
      recurrenceValue = { ...input.recurrence };
    }

    const row = await scopedDb.db
      .insertInto("app.tasks")
      .values({
        id: randomUUID(),
        owner_user_id: sql<string>`app.current_actor_user_id()`,
        list_id: listId,
        parent_task_id: input.parentTaskId ?? null,
        title: input.title,
        description: input.description ?? null,
        status,
        priority: input.priority ?? null,
        position: 0,
        due_at: input.dueAt ?? null,
        do_at: input.doAt ?? null,
        effort: input.effort ?? null,
        source,
        source_ref: input.sourceRef ?? null,
        external_key: input.externalKey ?? null,
        recurrence: recurrenceValue ? { ...recurrenceValue } : null,
        recurrence_series_id: recurrenceSeriesId,
        suggestion_metadata: input.suggestionMetadata as Record<string, unknown> | null,
        completed_at: completedAt,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new Error("Failed to create task");
    }
    return row;
  }

  async update(
    scopedDb: DataContextDb,
    taskId: string,
    input: UpdateTaskInput
  ): Promise<Task | undefined> {
    assertDataContextDb(scopedDb);

    // Ownership check: if the caller is moving the task to a different list, verify ownership.
    if (input.listId !== undefined) {
      const owned = await this.listsRepository.isOwnedByActor(scopedDb, input.listId);
      if (!owned) throw new HttpError(404, "List not found or not accessible");
    }
    // Ownership check: if the caller is reparenting the task, require owner_user_id match.
    if (input.parentTaskId != null) {
      const parentOwned = await scopedDb.db
        .selectFrom("app.tasks")
        .select("id")
        .where("id", "=", input.parentTaskId)
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .executeTakeFirst();
      if (!parentOwned) throw new HttpError(404, "Parent task not found or not accessible");
    }

    const updates: Updateable<TasksTable> = {
      updated_at: new Date()
    };

    if (input.title !== undefined) {
      updates.title = input.title;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.priority !== undefined) {
      updates.priority = input.priority;
    }
    if (input.dueAt !== undefined) {
      updates.due_at = input.dueAt;
    }
    if (input.doAt !== undefined) {
      updates.do_at = input.doAt;
    }
    if (input.effort !== undefined) {
      updates.effort = input.effort;
    }
    if (input.listId !== undefined) {
      updates.list_id = input.listId;
    }
    if (input.parentTaskId !== undefined) {
      updates.parent_task_id = input.parentTaskId;
    }
    if (input.status !== undefined) {
      updates.status = input.status;
      updates.completed_at = input.status === "done" ? new Date() : null;
    }

    // List move: drop assignments whose tag does not belong to the destination list, BEFORE the
    // move. Same ambient transaction as the rest of update() (withDataContext wraps the callback
    // in one transaction; scopedDb.db is that Transaction), so this is atomic with the move —
    // no nested transaction. Preserves the same-list invariant the task_tag_list_match trigger
    // enforces at assignment time. Matches the delete-with-reassign drop rule (deleteList).
    if (input.listId !== undefined) {
      await scopedDb.db
        .deleteFrom("app.task_tag_assignments")
        .where("task_id", "=", taskId)
        .where((eb) =>
          eb(
            "tag_id",
            "not in",
            eb.selectFrom("app.task_tags").select("id").where("list_id", "=", input.listId!)
          )
        )
        .execute();
    }

    const updated = await scopedDb.db
      .updateTable("app.tasks")
      .set(updates)
      .where("id", "=", taskId)
      .returningAll()
      .executeTakeFirst();

    if (!updated) {
      return undefined;
    }

    // --- Completion cascade ---
    if (input.status !== undefined) {
      const newStatus = input.status;

      if (newStatus === "done" || newStatus === "archived") {
        // Parent closing: cascade to open children.
        if (updated.parent_task_id === null) {
          await this.cascadeCloseChildren(scopedDb, taskId, newStatus);
        }
      }

      if (newStatus === "done" && updated.parent_task_id !== null) {
        // Child completed: check if all siblings are also done; if so, close the parent.
        await this.maybeAutoCloseParent(scopedDb, updated.parent_task_id);
      }

      // Recurrence: when a recurring task transitions to done, generate the next instance.
      // Recurring tasks cannot be parents (enforced by DB trigger), so there is no
      // interaction with the cascade above.
      if (newStatus === "done" && updated.recurrence != null) {
        await generateNext(scopedDb, updated);
      }
    }

    return updated;
  }

  /**
   * When a parent is set to `done` or `archived`, close all open children
   * (those not already in the target terminal status) to match.
   */
  private async cascadeCloseChildren(
    scopedDb: DataContextDb,
    parentId: string,
    parentStatus: "done" | "archived"
  ): Promise<void> {
    const openChildren = await scopedDb.db
      .selectFrom("app.tasks")
      .select("id")
      .where("parent_task_id", "=", parentId)
      .where("status", "!=", parentStatus)
      // A `suggested` child is a staged email-derived task nobody reviewed (#729 §5);
      // closing the parent must not silently mark it done/archived.
      .where("status", "!=", "suggested")
      .execute();

    if (openChildren.length === 0) return;

    const now = new Date();
    for (const child of openChildren) {
      await scopedDb.db
        .updateTable("app.tasks")
        .set({
          status: parentStatus,
          completed_at: parentStatus === "done" ? now : null,
          updated_at: now
        })
        .where("id", "=", child.id)
        .execute();

      await this.addActivity(scopedDb, child.id, {
        activityType: "status_changed",
        body: `Cascaded to ${parentStatus} when parent was closed`
      });
    }
  }

  /**
   * When a child task reaches `done`, check whether all siblings are also
   * `done`. If so, automatically close the parent.
   */
  private async maybeAutoCloseParent(scopedDb: DataContextDb, parentId: string): Promise<void> {
    const siblings = await scopedDb.db
      .selectFrom("app.tasks")
      .select(["id", "status"])
      .where("parent_task_id", "=", parentId)
      .execute();

    if (siblings.length === 0) return;

    const allDone = siblings.every((s) => s.status === "done");
    if (!allDone) return;

    const now = new Date();
    await scopedDb.db
      .updateTable("app.tasks")
      .set({ status: "done", completed_at: now, updated_at: now })
      .where("id", "=", parentId)
      .where("status", "!=", "done")
      .execute();

    await this.addActivity(scopedDb, parentId, {
      activityType: "completed",
      body: "All subtasks completed — parent auto-closed"
    });
  }

  async updateStatus(
    scopedDb: DataContextDb,
    taskId: string,
    status: TaskStatus
  ): Promise<Task | undefined> {
    return this.update(scopedDb, taskId, { status });
  }

  async addActivity(
    scopedDb: DataContextDb,
    taskId: string,
    input: AddTaskActivityInput
  ): Promise<TaskActivity> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .insertInto("app.task_activity")
      .values({
        id: randomUUID(),
        task_id: taskId,
        actor_user_id: sql<string>`app.current_actor_user_id()`,
        actor_kind: "user" as const,
        activity_type: input.activityType,
        body: input.body ?? null,
        created_at: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listActivity(scopedDb: DataContextDb, taskId: string): Promise<TaskActivity[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.task_activity")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  async listByParentId(scopedDb: DataContextDb, parentId: string): Promise<Task[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.tasks")
      .selectAll()
      .where("parent_task_id", "=", parentId)
      .orderBy("position", "asc")
      .orderBy("id")
      .execute();
  }

  /**
   * Set of visible task ids that carry the given tag (RLS-scoped). Used by the
   * GET /api/tasks `tagId` filter. The select is owner/share-scoped by RLS on
   * task_tag_assignments, so a foreign tag yields an empty set.
   */
  async taskIdsWithTag(scopedDb: DataContextDb, tagId: string): Promise<Set<string>> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.task_tag_assignments")
      .select("task_id")
      .where("tag_id", "=", tagId)
      .execute();
    return new Set(rows.map((r) => r.task_id));
  }

  async getTagsForTask(scopedDb: DataContextDb, taskId: string): Promise<TaskTag[]> {
    assertDataContextDb(scopedDb);
    return scopedDb.db
      .selectFrom("app.task_tag_assignments as a")
      .innerJoin("app.task_tags as g", "g.id", "a.tag_id")
      .selectAll("g")
      .where("a.task_id", "=", taskId)
      .orderBy("g.name")
      .execute();
  }

  /** Batch fetch tags for many tasks in ONE grouped query (avoids N+1). */
  async getTagsForTasks(
    scopedDb: DataContextDb,
    taskIds: readonly string[]
  ): Promise<Map<string, TaskTag[]>> {
    assertDataContextDb(scopedDb);
    const map = new Map<string, TaskTag[]>();
    if (taskIds.length === 0) return map;
    const rows = await scopedDb.db
      .selectFrom("app.task_tag_assignments as a")
      .innerJoin("app.task_tags as g", "g.id", "a.tag_id")
      .select([
        "a.task_id as task_id",
        "g.id as id",
        "g.owner_user_id as owner_user_id",
        "g.list_id as list_id",
        "g.name as name",
        "g.created_at as created_at"
      ])
      .where("a.task_id", "in", taskIds as string[])
      .orderBy("g.name")
      .execute();
    for (const row of rows) {
      const { task_id, ...tag } = row;
      const arr = map.get(task_id) ?? [];
      arr.push(tag as unknown as TaskTag);
      map.set(task_id, arr);
    }
    return map;
  }
}
