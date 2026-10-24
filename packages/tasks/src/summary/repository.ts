import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { localDay } from "@moss/shared";
import { localDayRange } from "@moss/module-sdk";
import { readActorTimezone } from "../drift.js";
import { TASK_SUMMARY_LIMIT, type TaskSummary, type TaskSummaryScope } from "./types.js";
import { taskDueState } from "./contract.js";

/** SELECT-only: unlike the task-list consumer, never reconciles recurring series. */
export async function readTaskSummary(
  db: DataContextDb,
  scope: TaskSummaryScope = "today",
  now = new Date()
): Promise<TaskSummary> {
  assertDataContextDb(db);
  const timeZone = await readActorTimezone(db);
  const localDate = localDay(now, timeZone);
  const { start, end } = localDayRange(localDate, timeZone);
  let query = db.db
    .selectFrom("app.tasks")
    .select([
      "id",
      "title",
      "status",
      "priority",
      "due_at",
      "completed_at",
      "updated_at",
      "recurrence"
    ]);
  if (scope === "completed") query = query.where("status", "=", "done");
  else if (scope !== "all") {
    query = query.where("status", "=", "todo");
    if (scope === "today")
      query = query.where((eb) => eb.or([eb("due_at", "<", end), eb("due_at", "is", null)]));
    else if (scope === "overdue") query = query.where("due_at", "<", start);
    else if (scope === "upcoming") query = query.where("due_at", ">=", end);
    else query = query.where("due_at", "is", null);
  }
  // RLS includes task-level shares; joining owner-only lists would hide shared records.
  const rows = await query
    .orderBy("due_at", (ob) => ob.asc().nullsLast())
    .orderBy("id")
    .limit(TASK_SUMMARY_LIMIT + 1)
    .execute();
  const iso = (v: Date | string | null): string | null =>
    v === null ? null : new Date(v).toISOString();
  return {
    scope,
    timeZone,
    localDate,
    retrievedAt: now.toISOString(),
    truncated: rows.length > TASK_SUMMARY_LIMIT,
    items: rows.slice(0, TASK_SUMMARY_LIMIT).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      dueAt: iso(row.due_at),
      dueState: taskDueState(row.status, iso(row.due_at), localDate, timeZone),
      completedAt: iso(row.completed_at),
      updatedAt: new Date(row.updated_at).toISOString(),
      recurring: row.recurrence !== null
    }))
  };
}
