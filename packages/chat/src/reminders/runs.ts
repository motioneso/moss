import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";
import type { ScheduledTaskRunDto } from "@moss/shared";
import type { DueReminder } from "./repository.js";

export async function recordReminderRun(
  db: DataContextDb,
  reminder: DueReminder,
  outcome: ScheduledTaskRunDto["outcome"],
  late: boolean,
  messageId: string | null = outcome === "delivered" ? reminder.reservedMessageId : null
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
      message_id: messageId,
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
    .leftJoin("app.chat_scheduled_reads as source_read", "source_read.reminder_id", "reminder.id")
    .leftJoin("app.chat_messages as message", (join) =>
      join
        .onRef("message.id", "=", "run.message_id")
        .onRef("message.owner_user_id", "=", "run.owner_user_id")
        .onRef("message.thread_id", "=", "reminder.thread_id")
    )
    .select([
      "source_read.operation",
      "run.at",
      "run.outcome",
      "run.late",
      "message.id",
      "message.body",
      "reminder.thread_id"
    ])
    .where("run.reminder_id", "=", reminderId)
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
        : row.outcome === "quiet"
          ? "Task checked successfully; nothing new to report"
          : row.outcome === "refused"
            ? "Task check refused; restore source access"
            : row.outcome === "failed"
              ? "Task check failed; check Tasks and AI settings"
              : row.operation
                ? "Task change reported"
                : row.late
                  ? "Reminder delivered late"
                  : "Reminder delivered",
    message:
      row.id && row.body !== null
        ? {
            id: row.id,
            threadId: row.thread_id,
            body: row.body,
            ...(row.operation && row.outcome === "delivered"
              ? { scheduledReadSource: "tasks" as const }
              : {})
          }
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
