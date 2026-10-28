import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  capHeartbeatItems,
  heartbeatRevision,
  parseHeartbeatSourceReadInput,
  type HeartbeatEvidenceItem,
  type HeartbeatSourceRead
} from "@moss/shared";
import { sql } from "kysely";

/**
 * Input must stay inside the read contract. Extra keys (an owner or user id) are refused, and the
 * query below filters on the actor the data context was opened for.
 */
export async function authorizeTasksHeartbeatRead(
  _scopedDb: DataContextDb,
  input: Record<string, unknown>
): Promise<boolean> {
  return parseHeartbeatSourceReadInput(input) !== null;
}

/** Open tasks that are overdue or due inside the horizon. Never advances recurring series. */
export const tasksHeartbeatWindowExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const parsed = parseHeartbeatSourceReadInput(input);
  if (!parsed) throw new Error("Invalid heartbeat read input");

  const now = new Date();
  const until = new Date(now.getTime() + parsed.horizonHours * 3_600_000);
  const owned = sql<string>`app.current_actor_user_id()`;

  const rows = await scopedDb.db
    .selectFrom("app.tasks")
    .select(["id", "title", "due_at", "priority", "status"])
    .where("owner_user_id", "=", owned)
    .where("status", "=", "todo")
    .where("due_at", "is not", null)
    .where("due_at", "<=", until)
    .orderBy("due_at", "asc")
    .orderBy("id")
    .limit(parsed.limit + 1)
    .execute();
  const later = await scopedDb.db
    .selectFrom("app.tasks")
    .select(sql<Date | null>`min(due_at)`.as("next_due_at"))
    .where("owner_user_id", "=", owned)
    .where("status", "=", "todo")
    .where("due_at", ">", until)
    .executeTakeFirst();

  const { items: bounded, truncated } = capHeartbeatItems(rows, parsed.limit);
  const items: HeartbeatEvidenceItem[] = bounded.map((task) => {
    const dueAt = task.due_at as Date;
    return {
      entityKey: `task:${task.id}`,
      episodeKey: `task:${task.id}:${dueAt.toISOString()}`,
      title: task.title,
      at: dueAt.toISOString(),
      kind: dueAt.getTime() < now.getTime() ? "task_overdue" : "task_due",
      facts: { priority: task.priority }
    };
  });

  const revision = heartbeatRevision(
    rows.map((task) =>
      [task.id, task.title, (task.due_at as Date).toISOString(), task.priority ?? ""].join("|")
    )
  );
  const nextDue = bounded
    .map((task) => task.due_at as Date)
    .find((dueAt) => dueAt.getTime() > now.getTime());
  const entersWindowAt = later?.next_due_at
    ? new Date(new Date(later.next_due_at).getTime() - parsed.horizonHours * 3_600_000)
    : null;
  const boundaries = [nextDue, entersWindowAt]
    .filter((value): value is Date => value != null)
    .sort((a, b) => a.getTime() - b.getTime());

  const data: HeartbeatSourceRead = {
    source: "tasks",
    revision,
    nextBoundaryAt: boundaries[0]?.toISOString() ?? null,
    freshness: "fresh",
    truncated,
    items
  };
  return { data };
};
