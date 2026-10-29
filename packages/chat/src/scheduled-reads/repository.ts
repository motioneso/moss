import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";

export async function readScheduledOperation(db: DataContextDb, reminderId: string) {
  assertDataContextDb(db);
  return db.db
    .selectFrom("app.chat_scheduled_reads")
    .selectAll()
    .where("reminder_id", "=", reminderId)
    .executeTakeFirst();
}

export async function saveScheduledOperation(
  db: DataContextDb,
  reminderId: string,
  itemId: string
) {
  assertDataContextDb(db);
  await db.db
    .insertInto("app.chat_scheduled_reads")
    .values({
      reminder_id: reminderId,
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      operation: "tasks.get",
      item_id: itemId,
      outcome: null
    })
    .executeTakeFirstOrThrow();
}

export async function recordReadOutcome(
  db: DataContextDb,
  reminderId: string,
  outcome: "success" | "refused" | "failed"
) {
  assertDataContextDb(db);
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({ outcome })
    .where("reminder_id", "=", reminderId)
    .executeTakeFirstOrThrow();
}

/** Called only under the responsibility lock in the result transaction. */
export async function recordScheduledObservation(
  db: DataContextDb,
  reminderId: string,
  outcome: "success" | "refused" | "failed",
  observationKey: string | null
) {
  assertDataContextDb(db);
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set(
      outcome === "success"
        ? { outcome, observation_key: observationKey, failure_streak: 0 }
        : { outcome, failure_streak: sql<number>`least(failure_streak, 2147483646) + 1` }
    )
    .where("reminder_id", "=", reminderId)
    .executeTakeFirstOrThrow();
}

/** FOR UPDATE hides paused rows under worker RLS; caller already holds the reminder advisory lock. */
export async function isPausedScheduledReadOccurrence(
  db: DataContextDb,
  reminderId: string,
  messageId: string
): Promise<boolean> {
  assertDataContextDb(db);
  const row = await db.db
    .selectFrom("app.chat_reminders as r")
    .innerJoin("app.chat_scheduled_reads as s", "s.reminder_id", "r.id")
    .select("r.id")
    .where("r.id", "=", reminderId)
    .where("r.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("s.attempt_message_id", "=", messageId)
    .where("r.reserved_message_id", "=", messageId)
    .where("r.state", "=", "paused")
    .executeTakeFirst();
  return !!row;
}
