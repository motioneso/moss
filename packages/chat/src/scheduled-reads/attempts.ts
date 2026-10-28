import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { assertDataContextDb, type DataContextDb, type DataContextRunner } from "@moss/db";
import { scopedJobDatabase, sendJob } from "@moss/jobs";
import { ReminderRepository, type DueReminder } from "../reminders/repository.js";
import { readScheduledOperation } from "./repository.js";
import {
  CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
  CHAT_SCHEDULED_READ_QUEUE,
  type ScheduledReadWatchdogPayload
} from "./queue.js";

export interface ScheduledReadAttempt {
  readonly messageId: string;
  readonly token: string;
  readonly ordinal: 1 | 2;
  readonly version: number;
}

const LEASE_SECONDS = 90;
const RENEWAL_MS = 20_000;
type Boss = Pick<PgBoss, "send">;

async function dbNow(db: DataContextDb) {
  assertDataContextDb(db);
  const result = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db.db);
  return new Date(result.rows[0]!.now);
}

function eligible(reminder: DueReminder, now: Date) {
  return (
    reminder.state === "queued" &&
    reminder.dueAt <= now &&
    (!reminder.deadlineAt || reminder.deadlineAt >= now)
  );
}

/** Callers hold the existing reminder lock throughout these short state transactions. */
export async function validScheduledReadAttempt(
  db: DataContextDb,
  reminder: DueReminder,
  attempt: ScheduledReadAttempt
): Promise<boolean> {
  const row = await readScheduledOperation(db, reminder.id);
  const now = await dbNow(db);
  return (
    !!row &&
    eligible(reminder, now) &&
    row.owner_user_id === reminder.ownerUserId &&
    reminder.reservedMessageId === attempt.messageId &&
    reminder.version === attempt.version &&
    row.attempt_message_id === attempt.messageId &&
    row.attempt_state === "running" &&
    row.attempt_token === attempt.token &&
    row.attempt_count === attempt.ordinal &&
    row.attempt_version === attempt.version &&
    row.attempt_lease_until !== null &&
    new Date(row.attempt_lease_until) > now
  );
}

async function sendWatchdog(
  db: DataContextDb,
  boss: Boss,
  reminder: DueReminder,
  attempt: ScheduledReadAttempt,
  generation: number,
  startAfter: Date
) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647)
    throw new Error("Scheduled read watchdog generation exhausted");
  const id = await sendJob<ScheduledReadWatchdogPayload>(
    boss,
    CHAT_SCHEDULED_READ_BOOKKEEPING_QUEUE,
    {
      actorUserId: reminder.ownerUserId,
      resourceId: reminder.id,
      version: attempt.version,
      idempotencyKey: attempt.messageId,
      operationId: attempt.token,
      step: generation
    },
    { db: scopedJobDatabase(db), startAfter }
  );
  if (!id) throw new Error("Scheduled read watchdog enqueue unavailable");
  return id;
}

export async function admitScheduledReadAttempt(
  db: DataContextDb,
  reminder: DueReminder,
  boss: Boss
): Promise<ScheduledReadAttempt | null> {
  const row = await readScheduledOperation(db, reminder.id);
  const now = await dbNow(db);
  if (!row || !eligible(reminder, now) || row.owner_user_id !== reminder.ownerUserId) return null;
  if (
    row.attempt_state === "legacy_unknown" ||
    row.attempt_state === "terminal" ||
    row.attempt_state === "bookkeeping_pending" ||
    row.attempt_count >= 2
  )
    return null;
  if (row.attempt_message_id !== null && row.attempt_message_id !== reminder.reservedMessageId)
    return null;
  if (
    row.attempt_state === "running" &&
    row.attempt_version === reminder.version &&
    row.attempt_lease_until !== null &&
    new Date(row.attempt_lease_until) > now
  )
    return null;
  const ordinal = row.attempt_count === 0 ? 1 : 2;
  const attempt: ScheduledReadAttempt = {
    messageId: reminder.reservedMessageId,
    version: reminder.version,
    token: randomUUID(),
    ordinal
  };
  const generation = row.watchdog_generation + 1;
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
  const jobId = await sendWatchdog(db, boss, reminder, attempt, generation, leaseUntil);
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({
      attempt_message_id: attempt.messageId,
      attempt_count: ordinal,
      attempt_state: "running",
      attempt_token: attempt.token,
      attempt_version: attempt.version,
      attempt_lease_until: leaseUntil,
      watchdog_token: attempt.token,
      watchdog_generation: generation,
      watchdog_job_id: jobId
    })
    .where("reminder_id", "=", reminder.id)
    .executeTakeFirstOrThrow();
  return attempt;
}

export async function renewScheduledReadAttempt(
  db: DataContextDb,
  reminder: DueReminder,
  attempt: ScheduledReadAttempt
): Promise<boolean> {
  if (!(await validScheduledReadAttempt(db, reminder, attempt))) return false;
  const result = await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({
      attempt_lease_until: sql<Date>`clock_timestamp() + interval '90 seconds'`
    })
    .where("reminder_id", "=", reminder.id)
    .where("attempt_token", "=", attempt.token)
    .where("attempt_lease_until", ">", sql<Date>`clock_timestamp()`)
    .executeTakeFirstOrThrow();
  return result.numUpdatedRows === 1n;
}

/** The same transition serves recognized source failure and abandoned ordinal one. */
export async function dispatchScheduledReadRecovery(
  db: DataContextDb,
  reminder: DueReminder,
  boss: Boss,
  failedAttempt?: ScheduledReadAttempt
): Promise<string | null> {
  const row = await readScheduledOperation(db, reminder.id);
  const now = await dbNow(db);
  if (
    !row ||
    !eligible(reminder, now) ||
    row.owner_user_id !== reminder.ownerUserId ||
    row.attempt_message_id !== reminder.reservedMessageId ||
    row.attempt_count !== 1
  )
    return null;
  if (row.attempt_state === "retry_pending") return row.recovery_job_id;
  if (row.attempt_state !== "running" || row.recovery_job_id !== null) return null;
  const active =
    row.attempt_version === reminder.version &&
    row.attempt_lease_until !== null &&
    new Date(row.attempt_lease_until) > now;
  if (failedAttempt) {
    if (!(await validScheduledReadAttempt(db, reminder, failedAttempt))) return null;
  } else if (active) return null;
  const id = await sendJob(
    boss,
    CHAT_SCHEDULED_READ_QUEUE,
    {
      actorUserId: reminder.ownerUserId,
      resourceId: reminder.id,
      version: reminder.version,
      idempotencyKey: reminder.reservedMessageId
    },
    { db: scopedJobDatabase(db) }
  );
  if (!id) throw new Error("Scheduled read recovery enqueue unavailable");
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({
      attempt_state: "retry_pending",
      attempt_token: null,
      attempt_version: null,
      attempt_lease_until: null,
      recovery_job_id: id
    })
    .where("reminder_id", "=", reminder.id)
    .executeTakeFirstOrThrow();
  return id;
}

/** Stops and joins any in-progress short renewal transaction on every worker exit. */
export function startScheduledReadRenewal(
  dataContext: DataContextRunner,
  actorUserId: string,
  reminderId: string,
  attempt: ScheduledReadAttempt
) {
  let pending: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = dataContext
      .withDataContext({ actorUserId, requestId: "scheduled-read:renew" }, async (db) => {
        const reminder = await new ReminderRepository().lockForDelivery(db, reminderId);
        return reminder ? renewScheduledReadAttempt(db, reminder, attempt) : false;
      })
      .catch(() => false)
      .finally(() => {
        pending = undefined;
      });
  }, RENEWAL_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

/** Invoked after final effects, in their same transaction, under the reminder lock. */
export async function finishScheduledReadAttempt(
  db: DataContextDb,
  reminder: DueReminder,
  attempt?: ScheduledReadAttempt
) {
  assertDataContextDb(db);
  const row = await readScheduledOperation(db, reminder.id);
  if (!row || row.attempt_message_id !== reminder.reservedMessageId)
    throw new Error("Scheduled read completion identity changed");
  if (attempt) {
    if (!(await validScheduledReadAttempt(db, reminder, attempt)))
      throw new Error("Scheduled read completion lost authority");
  } else if (
    row.attempt_state === "running" &&
    row.attempt_token &&
    row.attempt_version &&
    (row.attempt_count === 1 || row.attempt_count === 2)
  ) {
    if (
      await validScheduledReadAttempt(db, reminder, {
        messageId: reminder.reservedMessageId,
        token: row.attempt_token,
        ordinal: row.attempt_count,
        version: row.attempt_version
      })
    )
      throw new Error("Scheduled read execution is still active");
  }
  const next = await db.db
    .selectFrom("app.chat_reminders")
    .select("reserved_message_id")
    .where("id", "=", reminder.id)
    .executeTakeFirstOrThrow();
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set(
      next.reserved_message_id !== reminder.reservedMessageId
        ? {
            attempt_state: "ready",
            attempt_message_id: null,
            attempt_count: 0,
            attempt_token: null,
            attempt_version: null,
            attempt_lease_until: null,
            recovery_job_id: null,
            watchdog_token: null,
            watchdog_generation: 0,
            watchdog_job_id: null
          }
        : {
            attempt_state: "terminal",
            attempt_token: null,
            attempt_version: null,
            attempt_lease_until: null
          }
    )
    .where("reminder_id", "=", reminder.id)
    .executeTakeFirstOrThrow();
}

/** B drives expiry/completion only after this current receipt check returns expired. */
export async function advanceScheduledReadWatchdog(
  db: DataContextDb,
  reminder: DueReminder,
  boss: Boss,
  job: { readonly id: string; readonly data: ScheduledReadWatchdogPayload }
): Promise<"stale" | "waiting" | "expired"> {
  const payload = job.data;
  const row = await readScheduledOperation(db, reminder.id);
  if (
    !Number.isSafeInteger(payload.step) ||
    payload.step < 0 ||
    payload.step > 2_147_483_647 ||
    !row ||
    payload.actorUserId !== reminder.ownerUserId ||
    payload.resourceId !== reminder.id ||
    payload.idempotencyKey !== reminder.reservedMessageId ||
    row.attempt_message_id !== reminder.reservedMessageId ||
    row.attempt_state === "terminal" ||
    row.attempt_state === "retry_pending" ||
    row.attempt_state === "bookkeeping_pending" ||
    row.attempt_state === "ready" ||
    row.watchdog_token !== (payload.operationId ?? null) ||
    row.watchdog_generation !== payload.step ||
    row.watchdog_job_id !== job.id
  )
    return "stale";
  if (
    row.attempt_state !== "running" ||
    !row.attempt_token ||
    !row.attempt_version ||
    (row.attempt_count !== 1 && row.attempt_count !== 2)
  )
    return "expired";
  const attempt: ScheduledReadAttempt = {
    messageId: reminder.reservedMessageId,
    token: row.attempt_token,
    ordinal: row.attempt_count,
    version: row.attempt_version
  };
  if (!(await validScheduledReadAttempt(db, reminder, attempt))) return "expired";
  const generation = row.watchdog_generation + 1;
  const id = await sendWatchdog(
    db,
    boss,
    reminder,
    attempt,
    generation,
    new Date(row.attempt_lease_until!)
  );
  await db.db
    .updateTable("app.chat_scheduled_reads")
    .set({
      watchdog_generation: generation,
      watchdog_job_id: id
    })
    .where("reminder_id", "=", reminder.id)
    .executeTakeFirstOrThrow();
  return "waiting";
}
