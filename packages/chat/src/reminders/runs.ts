import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";
import type { ScheduledTaskRunDto } from "@moss/shared";
import type { DueReminder } from "./repository.js";

export async function recordReminderRun(
  db: DataContextDb,
  reminder: DueReminder,
  outcome: "delivered" | "expired",
  late: boolean
) {
  await db.db
    .insertInto("app.chat_reminder_runs")
    .values({
      id: randomUUID(),
      reminder_id: reminder.id,
      owner_user_id: reminder.ownerUserId,
      version: reminder.version,
      due_at: sql<Date>`(select due_at from app.chat_reminders where id = ${reminder.id}::uuid)`,
      at: sql<Date>`now()`,
      outcome,
      message_id: outcome === "delivered" ? reminder.reservedMessageId : null,
      late
    })
    .execute();
}

export async function readReminderRuns(
  db: DataContextDb,
  reminderId: string
): Promise<ScheduledTaskRunDto[]> {
  const rows = await db.db
    .selectFrom("app.chat_reminder_runs as run")
    .innerJoin("app.chat_reminders as reminder", "reminder.id", "run.reminder_id")
    .leftJoin("app.chat_messages as message", (join) =>
      join
        .onRef("message.id", "=", "run.message_id")
        .onRef("message.owner_user_id", "=", "run.owner_user_id")
        .on("message.role", "=", "assistant")
        .on("message.status", "=", "stored")
    )
    .leftJoin("app.chat_threads as thread", (join) =>
      join
        .onRef("thread.id", "=", "message.thread_id")
        .on("thread.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .on("thread.surface", "=", "drawer")
        .on("thread.incognito", "=", false)
    )
    .select([
      "run.at",
      "run.outcome",
      "run.late",
      "message.id",
      "message.body",
      "thread.id as destination_thread_id"
    ])
    .where("run.reminder_id", "=", reminderId)
    .where("run.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("reminder.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .orderBy("run.at", "desc")
    .orderBy("run.id", "desc")
    .limit(20)
    .execute();
  return rows.map((row) => ({
    at: new Date(row.at).toISOString(),
    outcome: row.outcome,
    summary:
      row.outcome === "expired"
        ? "Skipped because its deadline passed"
        : row.late
          ? "Reminder delivered late"
          : "Reminder delivered",
    message:
      row.id && row.body !== null && row.destination_thread_id
        ? { id: row.id, threadId: row.destination_thread_id, body: row.body }
        : null
  }));
}

export async function advanceReminder(
  db: DataContextDb,
  reminder: DueReminder,
  next: { dueAt: Date; localDue: string | null }
) {
  const row = await db.db
    .updateTable("app.chat_reminders")
    .set({
      due_at: next.dueAt,
      local_due: next.localDue,
      version: reminder.version + 1,
      reserved_message_id: randomUUID()
    })
    .where("id", "=", reminder.id)
    .where("version", "=", reminder.version)
    .returning(["id", "version", "due_at"])
    .executeTakeFirstOrThrow();
  return { id: row.id, version: row.version, dueAt: new Date(row.due_at) };
}
