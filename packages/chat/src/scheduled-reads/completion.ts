import type { PgBoss } from "pg-boss";
import type { DataContextDb } from "@moss/db";
import { ChatRepository } from "../repository.js";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { persistReminderResult } from "../reminders/deliver.js";
import { nextReminderOccurrence } from "../reminders/repeating.js";
import { recurringReadFailureMessage, scheduledFailureNotification } from "./observation.js";
import { persistQuietScheduledRun } from "./recurring.js";
import { recordReadOutcome, recordScheduledObservation } from "./repository.js";
import { finishScheduledReadAttempt, type ScheduledReadAttempt } from "./attempts.js";
import { scheduledInterruptionMessage } from "./report.js";

export interface ScheduledReadCompletionDeps {
  readonly boss?: Pick<PgBoss, "send">;
  readonly enqueueNotification?: (db: DataContextDb, reminder: DueReminder) => Promise<void>;
}

export interface ScheduledReadResult {
  readonly outcome: "success" | "refused" | "failed";
  readonly text: string;
  readonly observationKey?: string;
  readonly quiet?: boolean;
  readonly interruption?: "interrupted" | "unknown";
}

/** Caller holds thread selection and reminder locks; all final effects commit together. */
export async function completeScheduledRead(
  db: DataContextDb,
  reminder: DueReminder,
  now: Date,
  previousStreak: number,
  result: ScheduledReadResult,
  deps: ScheduledReadCompletionDeps,
  attempt?: ScheduledReadAttempt
): Promise<string> {
  const reminders = new ReminderRepository();
  const { outcome } = result;
  const continues =
    !reminder.repeat ||
    !reminder.deadlineAt ||
    nextReminderOccurrence({ ...reminder, repeat: reminder.repeat }, now).dueAt <=
      reminder.deadlineAt;
  const postedText =
    reminder.repeat && outcome !== "success"
      ? result.interruption
        ? scheduledInterruptionMessage(result.interruption, continues)
        : recurringReadFailureMessage(outcome, continues)
      : result.text;
  if (reminder.repeat) {
    if (!deps.boss) throw new Error("Recurring scheduled read queue unavailable");
    await recordScheduledObservation(db, reminder.id, outcome, result.observationKey ?? null);
    if (result.quiet || (outcome !== "success" && !scheduledFailureNotification(previousStreak))) {
      await persistQuietScheduledRun(
        db,
        reminder,
        outcome === "success" ? "quiet" : outcome,
        now,
        reminders,
        deps.boss
      );
      await finishScheduledReadAttempt(db, reminder, attempt);
      return outcome === "success" ? "quiet" : outcome;
    }
  } else await recordReadOutcome(db, reminder.id, outcome);
  await persistReminderResult(db, reminder, postedText, now, {
    chat: new ChatRepository(),
    reminders,
    boss: deps.boss,
    runOutcome: outcome === "success" ? "delivered" : outcome,
    enqueueNotification: deps.enqueueNotification,
    ...(outcome === "success" ? { scheduledReadSource: "tasks" as const } : {})
  });
  await finishScheduledReadAttempt(db, reminder, attempt);
  return outcome;
}
