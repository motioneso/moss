import type { PgBoss } from "pg-boss";
import type { DataContextDb } from "@moss/db";
import type { DueReminder, ReminderRepository } from "../reminders/repository.js";
import { recordReminderRun, advanceReminder } from "../reminders/runs.js";
import { nextReminderOccurrence } from "../reminders/repeating.js";
import { enqueueReminderDelivery } from "../reminders/deliver.js";

/** No message or notification is created for a quiet success or a suppressed failure. */
export async function persistQuietScheduledRun(
  db: DataContextDb,
  reminder: DueReminder,
  outcome: "quiet" | "failed" | "refused",
  now: Date,
  reminders: ReminderRepository,
  boss: Pick<PgBoss, "send">
) {
  if (!reminder.repeat) throw new Error("Recurring check cadence unavailable");
  await recordReminderRun(db, reminder, outcome, false);
  const next = nextReminderOccurrence({ ...reminder, repeat: reminder.repeat }, now);
  if (reminder.deadlineAt && next.dueAt > reminder.deadlineAt) {
    await reminders.markDelivered(db, reminder.id, false);
  } else {
    const saved = await advanceReminder(db, reminder, next);
    await enqueueReminderDelivery(boss, db, reminder.ownerUserId, saved);
  }
}
