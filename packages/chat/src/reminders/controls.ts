import type { PgBoss } from "pg-boss";
import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb, type ChatReminderState } from "@moss/db";
import { enqueueReminderDelivery } from "./deliver.js";
import { lockNotificationDelivery, type SavedReminder } from "./repository.js";

export interface ControlledReminder extends SavedReminder {
  readonly text: string;
  readonly state: ChatReminderState;
}
export type ReminderControlResult =
  | {
      readonly kind: "changed" | "unchanged" | "not_pending" | "stale";
      readonly reminder: ControlledReminder;
    }
  | { readonly kind: "missing" };

export async function lockReminderControl(
  scopedDb: DataContextDb,
  id: string
): Promise<ControlledReminder | undefined> {
  assertDataContextDb(scopedDb);
  await lockNotificationDelivery(scopedDb, id);
  const row = await scopedDb.db
    .selectFrom("app.chat_reminders")
    .select(["id", "reminder_text", "state", "version", "due_at"])
    .where("id", "=", id)
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .forUpdate()
    .executeTakeFirst();
  return (
    row && {
      id: row.id,
      text: row.reminder_text,
      state: row.state,
      version: row.version,
      dueAt: new Date(row.due_at)
    }
  );
}

export async function pauseReminderById(
  scopedDb: DataContextDb,
  id: string
): Promise<ReminderControlResult> {
  const reminder = await lockReminderControl(scopedDb, id);
  if (!reminder) return { kind: "missing" };
  if (reminder.state === "paused") return { kind: "unchanged", reminder };
  if (reminder.state !== "queued") return { kind: "not_pending", reminder };
  await scopedDb.db
    .updateTable("app.chat_reminders")
    .set({ state: "paused", version: reminder.version + 1 })
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return {
    kind: "changed",
    reminder: { ...reminder, state: "paused", version: reminder.version + 1 }
  };
}

export async function resumeReminderById(
  scopedDb: DataContextDb,
  boss: Pick<PgBoss, "send">,
  actorUserId: string,
  id: string
): Promise<ReminderControlResult> {
  const reminder = await lockReminderControl(scopedDb, id);
  if (!reminder) return { kind: "missing" };
  if (reminder.state === "queued") return { kind: "unchanged", reminder };
  if (reminder.state !== "paused") return { kind: "not_pending", reminder };
  await scopedDb.db
    .updateTable("app.chat_reminders")
    .set({ state: "queued", version: reminder.version + 1 })
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const resumed = { ...reminder, state: "queued" as const, version: reminder.version + 1 };
  await enqueueReminderDelivery(boss, scopedDb, actorUserId, resumed);
  return { kind: "changed", reminder: resumed };
}

export async function deleteReminderById(
  scopedDb: DataContextDb,
  id: string,
  expectedVersion?: number
): Promise<ReminderControlResult> {
  const reminder = await lockReminderControl(scopedDb, id);
  if (!reminder) return { kind: "missing" };
  if (expectedVersion !== undefined && reminder.version !== expectedVersion)
    return { kind: "stale", reminder };
  await scopedDb.db.deleteFrom("app.chat_reminders").where("id", "=", id).executeTakeFirstOrThrow();
  return { kind: "changed", reminder };
}
