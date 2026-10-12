import { sql } from "kysely";
import { assertDataContextDb, type ChatReminderState, type DataContextDb } from "@moss/db";
import type { ScheduledTaskDto, ScheduledTaskRunDto, ScheduledTaskState } from "@moss/shared";

interface ScheduledReminderRow {
  readonly id: string;
  readonly reminder_text: string;
  readonly state: ChatReminderState;
  readonly thread_id: string;
  readonly due_at: Date;
  readonly deadline_at: Date | null;
  readonly created_at: Date;
  readonly delivered_at: Date | null;
  readonly expired_at: Date | null;
  readonly late: boolean | null;
  readonly message_id: string | null;
  readonly message_body: string | null;
  readonly read_outcome?: "success" | "refused" | "failed" | null;
}

const STATES: Record<ChatReminderState, ScheduledTaskState> = {
  queued: "active",
  paused: "paused",
  delivered: "completed",
  expired: "expired",
  failed: "failed",
  cancelled: "cancelled"
};

export function scheduledReminder(row: ScheduledReminderRow): ScheduledTaskDto {
  const runs: ScheduledTaskRunDto[] = [];
  if (row.state === "delivered" && row.delivered_at) {
    runs.push({
      at: row.delivered_at.toISOString(),
      outcome: "delivered",
      summary: row.read_outcome
        ? row.read_outcome === "success"
          ? "Task status checked"
          : "Task check failed"
        : row.late
          ? "Reminder delivered late"
          : "Reminder delivered",
      message:
        row.message_id !== null && row.message_body !== null
          ? {
              id: row.message_id,
              threadId: row.thread_id,
              body: row.message_body,
              ...(row.read_outcome === "success" ? { scheduledReadSource: "tasks" as const } : {})
            }
          : null
    });
  }
  if (row.state === "expired" && row.expired_at) {
    runs.push({
      at: row.expired_at.toISOString(),
      outcome: "expired",
      summary: "Skipped because its deadline passed",
      message: null
    });
  }
  return {
    id: row.id,
    title: row.reminder_text,
    instruction: row.reminder_text,
    group: "Reminders",
    state: row.read_outcome && row.read_outcome !== "success" ? "failed" : STATES[row.state],
    dueAt: row.due_at.toISOString(),
    deadlineAt: row.deadline_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    runs
  };
}

export async function listScheduledReminders(scopedDb: DataContextDb): Promise<ScheduledTaskDto[]> {
  assertDataContextDb(scopedDb);
  const rows = await scopedDb.db
    .selectFrom("app.chat_reminders as reminder")
    .leftJoin("app.chat_scheduled_reads as source_read", "source_read.reminder_id", "reminder.id")
    .leftJoin("app.chat_messages as message", (join) =>
      join
        .onRef("message.id", "=", "reminder.reserved_message_id")
        .onRef("message.thread_id", "=", "reminder.thread_id")
        .onRef("message.owner_user_id", "=", "reminder.owner_user_id")
        .on("message.role", "=", "assistant")
        .on("reminder.state", "=", "delivered")
    )
    .select([
      "source_read.outcome as read_outcome",
      "reminder.id",
      "reminder.reminder_text",
      "reminder.state",
      "reminder.thread_id",
      "reminder.due_at",
      "reminder.deadline_at",
      "reminder.created_at",
      "reminder.delivered_at",
      "reminder.expired_at",
      "reminder.late",
      "message.id as message_id",
      "message.body as message_body"
    ])
    .where("reminder.owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .orderBy("reminder.due_at", "asc")
    .orderBy("reminder.id", "asc")
    .execute();
  return rows.map(scheduledReminder);
}
