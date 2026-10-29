import { sql } from "kysely";
import type { PgBoss, WorkOptions } from "pg-boss";
import type { DataContextRunner, DataContextDb } from "@moss/db";
import { scopedJobDatabase, sendJob } from "@moss/jobs";
import { ChatRepository } from "../repository.js";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { lockReminderDestination } from "../reminders/destination.js";
import { enqueueReminderNotification } from "../reminders/notifications.js";
import { recordReminderRun } from "../reminders/runs.js";
import {
  advanceScheduledReadWatchdog,
  dispatchScheduledReadRecovery,
  finishScheduledReadAttempt,
  validScheduledReadAttempt
} from "./attempts.js";
import { completeScheduledRead, type ScheduledReadCompletionDeps } from "./completion.js";
import { readScheduledOperation, isPausedScheduledReadOccurrence } from "./repository.js";
import { scheduledInterruptionMessage } from "./report.js";
import {
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  CHAT_SCHEDULED_READ_QUEUE,
  type ScheduledReadWatchdogPayload
} from "./queue.js";

export interface ScheduledReadBookkeepingDeps extends ScheduledReadCompletionDeps {
  readonly dataContext: DataContextRunner;
}
export interface ScheduledReadRecoveryTarget {
  readonly actorUserId: string;
  readonly resourceId: string;
  readonly expectedMessageId: string;
}
export type ScheduledReadRecoveryOutcome =
  | "inactive"
  | "stale"
  | "paused"
  | "deferred"
  | "waiting"
  | "in_flight"
  | "recovery_dispatched"
  | "awaiting_recovery"
  | "expired"
  | "failed";

/** Caller holds the reminder lock. Also used by the bounded legacy seed in B2. */
export async function scheduleScheduledReadBookkeeping(
  db: DataContextDb,
  reminder: DueReminder,
  boss: Pick<PgBoss, "send">,
  startAfter: Date
): Promise<string> {
  const row = await readScheduledOperation(db, reminder.id);
  if (
    !row ||
    row.attempt_message_id !== reminder.reservedMessageId ||
    !["running", "legacy_unknown"].includes(row.attempt_state)
  )
    throw new Error("Scheduled read bookkeeping identity unavailable");
  const generation = row.watchdog_generation + 1;
  if (!Number.isSafeInteger(generation) || generation > 2_147_483_647)
    throw new Error("Scheduled read watchdog generation exhausted");
  const id = await sendJob<ScheduledReadWatchdogPayload>(
    boss,
    CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
    {
      actorUserId: reminder.ownerUserId,
      resourceId: reminder.id,
      version: reminder.version,
      idempotencyKey: reminder.reservedMessageId,
      ...(row.watchdog_token ? { operationId: row.watchdog_token } : {}),
      step: generation
    },
    { db: scopedJobDatabase(db), startAfter }
  );
  if (!id) throw new Error("Scheduled read bookkeeping enqueue unavailable");
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({ watchdog_generation: generation, watchdog_job_id: id })
    .where("reminder_id", "=", reminder.id)
    .executeTakeFirstOrThrow();
  return id;
}

/** Only an actual terminal queue receipt establishes exhausted recovery delivery. */
async function recoveryExhausted(db: DataContextDb, reminder: DueReminder, id: string) {
  const result = await sql<{ exhausted: boolean }>`select exists (
    select 1 from pgboss.job where id = ${id}::uuid
      and name = ${CHAT_SCHEDULED_READ_QUEUE} and state = 'failed'
      and retry_count >= retry_limit
      and data->>'actorUserId' = ${reminder.ownerUserId}
      and data->>'resourceId' = ${reminder.id}
      and data->>'idempotencyKey' = ${reminder.reservedMessageId}
  ) as exhausted`.execute(db.db);
  return result.rows[0]?.exhausted === true;
}

async function recover(
  target: ScheduledReadRecoveryTarget,
  deps: ScheduledReadBookkeepingDeps,
  wake?: { readonly id: string; readonly data: ScheduledReadWatchdogPayload }
): Promise<ScheduledReadRecoveryOutcome> {
  return deps.dataContext.withDataContext(
    {
      actorUserId: target.actorUserId,
      requestId: `scheduled-read:bookkeeping:${target.resourceId}`
    },
    async (db) => {
      const chat = new ChatRepository();
      const reminders = new ReminderRepository();
      await chat.lockThreadSelection(db);
      const reminder = await reminders.lockForDelivery(db, target.resourceId);
      if (!reminder)
        return (await isPausedScheduledReadOccurrence(
          db,
          target.resourceId,
          target.expectedMessageId
        ))
          ? "paused"
          : "inactive";
      if (
        reminder.ownerUserId !== target.actorUserId ||
        reminder.reservedMessageId !== target.expectedMessageId
      )
        return "inactive";
      const row = await readScheduledOperation(db, reminder.id);
      if (
        !row ||
        row.owner_user_id !== target.actorUserId ||
        row.attempt_message_id !== target.expectedMessageId ||
        row.attempt_state === "ready" ||
        row.attempt_state === "terminal" ||
        !["queued", "paused"].includes(reminder.state)
      )
        return "inactive";
      if (!deps.boss) throw new Error("Scheduled read bookkeeping queue unavailable");
      if (wake) {
        const disposition = await advanceScheduledReadWatchdog(db, reminder, deps.boss, wake);
        if (disposition !== "expired") return disposition;
      }
      if (reminder.state === "paused") return "paused";
      const now = await reminders.now(db);
      if (now < reminder.dueAt) {
        if (row.attempt_state === "running" || row.attempt_state === "legacy_unknown")
          await scheduleScheduledReadBookkeeping(db, reminder, deps.boss, reminder.dueAt);
        return "deferred";
      }
      if (
        row.attempt_state === "running" &&
        row.attempt_token &&
        row.attempt_version &&
        (row.attempt_count === 1 || row.attempt_count === 2) &&
        (await validScheduledReadAttempt(db, reminder, {
          messageId: reminder.reservedMessageId,
          token: row.attempt_token,
          ordinal: row.attempt_count,
          version: row.attempt_version
        }))
      )
        return "in_flight";
      const expired = reminder.deadlineAt !== null && now > reminder.deadlineAt;
      if (
        !expired &&
        row.attempt_state === "running" &&
        row.attempt_count === 1 &&
        !row.recovery_job_id
      ) {
        return (await dispatchScheduledReadRecovery(db, reminder, deps.boss))
          ? "recovery_dispatched"
          : "inactive";
      }
      if (
        !expired &&
        row.attempt_state === "retry_pending" &&
        row.recovery_job_id &&
        !(await recoveryExhausted(db, reminder, row.recovery_job_id))
      )
        return "awaiting_recovery";
      // No valid matching execution exists. Fence it before any final effects, in this transaction.
      await db.db
        .updateTable("app.chat_scheduled_reads")
        .set({
          attempt_state: "bookkeeping_pending",
          attempt_token: null,
          attempt_version: null,
          attempt_lease_until: null
        })
        .where("reminder_id", "=", reminder.id)
        .executeTakeFirstOrThrow();
      if (expired) {
        if (reminder.repeat) await recordReminderRun(db, reminder, "expired", false);
        await reminders.markExpired(db, reminder.id);
        await finishScheduledReadAttempt(db, reminder);
        return "expired";
      }
      const destination = await lockReminderDestination(
        db,
        reminder.ownerUserId,
        reminder.threadId,
        reminder.destinationTitle
      );
      if (!destination) {
        await reminders.markFailed(db, reminder.id);
        await finishScheduledReadAttempt(db, reminder);
        return "failed";
      }
      const interruption = row.attempt_state === "legacy_unknown" ? "unknown" : "interrupted";
      await completeScheduledRead(
        db,
        reminder,
        now,
        row.failure_streak,
        {
          outcome: "failed",
          text: scheduledInterruptionMessage(interruption),
          interruption
        },
        deps
      );
      return "failed";
    }
  );
}

/** One exact owner/occurrence only; never grants an execution or replaces a recovery receipt. */
export function recoverScheduledReadOccurrence(
  target: ScheduledReadRecoveryTarget,
  deps: ScheduledReadBookkeepingDeps
): Promise<ScheduledReadRecoveryOutcome> {
  return recover(target, deps);
}

export function runScheduledReadBookkeepingJob(
  job: { readonly id: string; readonly data: ScheduledReadWatchdogPayload },
  deps: ScheduledReadBookkeepingDeps
): Promise<ScheduledReadRecoveryOutcome> {
  return recover(
    {
      actorUserId: job.data.actorUserId,
      resourceId: job.data.resourceId,
      expectedMessageId: job.data.idempotencyKey
    },
    deps,
    job
  );
}

export function registerScheduledReadBookkeepingWorker(
  boss: PgBoss,
  deps: ScheduledReadBookkeepingDeps,
  workOptions?: WorkOptions
): Promise<string> {
  return boss.work<ScheduledReadWatchdogPayload>(
    CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
    { pollingIntervalSeconds: 1, ...workOptions, includeMetadata: true },
    async ([job]) => {
      if (job)
        await runScheduledReadBookkeepingJob(job, {
          ...deps,
          boss,
          enqueueNotification: (db, reminder) => enqueueReminderNotification(boss, db, reminder)
        });
    }
  );
}
