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
