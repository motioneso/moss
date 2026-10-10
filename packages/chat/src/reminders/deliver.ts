// #3309: puts one due reminder into its owner's Main chat, once. The job only names the
// reminder; every fact the delivery depends on is re-read under the row lock.

import type { PgBoss, WorkOptions } from "pg-boss";

import { sql } from "kysely";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import {
  DATA_CONTEXT_WORKER_POLLING_INTERVAL_SECONDS,
  registerDataContextWorker,
  scopedJobDatabase,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";

import { ChatRepository } from "../repository.js";
import { notifyReminderArrival } from "./live-arrival.js";
import { ReminderRepository, type SavedReminder } from "./repository.js";
import { REMINDER_LATE_AFTER_MS, reminderDeliveredMessage } from "./wording.js";

export const CHAT_DELIVER_REMINDER_QUEUE = "chat.deliver-reminder";

// A reminder can wait 30 days, so its job is kept past the longest delay plus a margin.
export const CHAT_DELIVER_REMINDER_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_DELIVER_REMINDER_QUEUE,
  options: {
    retryLimit: 8,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 900,
    retentionSeconds: 3_456_000,
    deleteAfterSeconds: 86_400
  }
};

export interface DeliverReminderJobPayload extends ActorScopedJobPayload {
  readonly resourceId: string;
  readonly version: number;
}

export type ReminderDeliveryOutcome =
  | "delivered"
  | "missing"
  | "already_delivered"
  | "cancelled"
  | "stale_version"
  | "not_main"
  | "failed";

type ReminderDeliveryDeps = {
  readonly reminders: ReminderRepository;
  readonly chat: ChatRepository;
};

/** Enqueues delivery inside the caller's transaction, so a rollback drops the job too. */
export async function enqueueReminderDelivery(
  boss: Pick<PgBoss, "send">,
  scopedDb: DataContextDb,
  actorUserId: string,
  reminder: SavedReminder
): Promise<void> {
  await sendJob<DeliverReminderJobPayload>(
    boss,
    CHAT_DELIVER_REMINDER_QUEUE,
    { actorUserId, resourceId: reminder.id, version: reminder.version },
    { startAfter: reminder.dueAt, db: scopedJobDatabase(scopedDb) }
  );
}

export async function deliverDueReminder(
  scopedDb: DataContextDb,
  payload: DeliverReminderJobPayload,
  deps: ReminderDeliveryDeps
): Promise<ReminderDeliveryOutcome> {
  const reminder = await deps.reminders.lockForDelivery(scopedDb, payload.resourceId);

  if (!reminder) return unlockedOutcome(scopedDb, payload, deps);
  if (reminder.ownerUserId !== payload.actorUserId) return "missing";
  if (reminder.state !== "queued") return "already_delivered";
  if (reminder.version !== payload.version) return "stale_version";

  const now = await deps.reminders.now(scopedDb);

  // A job that runs early fails and retries, so it can never deliver before the due time.
  if (now.getTime() < reminder.dueAt.getTime()) {
    throw new Error("chat reminder delivery ran before its due time");
  }

  const main = await deps.chat.getMainThread(scopedDb, reminder.ownerUserId);
  if (!main || main.id !== reminder.threadId) {
    await deps.reminders.markFailed(scopedDb, reminder.id);
    return "not_main";
  }

  const late = now.getTime() - reminder.dueAt.getTime() > REMINDER_LATE_AFTER_MS;
  await deps.chat.insertReservedAssistantMessage(scopedDb, {
    id: reminder.reservedMessageId,
    threadId: reminder.threadId,
    body: reminderDeliveredMessage(reminder.text, late),
    origin: { version: 1, kind: "reminder", event: "delivered", reminderId: reminder.id, late },
    now
  });
  await deps.reminders.markDelivered(scopedDb, reminder.id, late);
  // #3195: Postgres delivers this only if the delivery commits, so a rollback shows nothing.
  await notifyReminderArrival(scopedDb, {
    actorUserId: reminder.ownerUserId,
    threadId: reminder.threadId,
    messageId: reminder.reservedMessageId
  });
  return "delivered";
}

/**
 * The worker can lock only queued rows, so a delivered or cancelled row reads back unlocked.
 * A cancelled reminder ends the job with nothing posted.
 */
async function unlockedOutcome(
  scopedDb: DataContextDb,
  payload: DeliverReminderJobPayload,
  deps: ReminderDeliveryDeps
): Promise<ReminderDeliveryOutcome> {
  const current = await deps.reminders.readState(scopedDb, payload.resourceId);
  if (current?.ownerUserId !== payload.actorUserId) return "missing";
  return current.state === "cancelled" ? "cancelled" : "already_delivered";
}

/**
 * Runs one delivery attempt. Earlier attempts throw so pg-boss retries them. The last attempt
 * undoes any partial delivery and marks the reminder failed, so it never holds a slot forever.
 * Missing retry metadata counts as the last attempt.
 */
export async function runReminderDeliveryJob(
  scopedDb: DataContextDb,
  job: {
    readonly data: DeliverReminderJobPayload;
    readonly retryCount?: number;
    readonly retryLimit?: number;
  },
  deps: ReminderDeliveryDeps
): Promise<ReminderDeliveryOutcome> {
  const final =
    typeof job.retryCount !== "number" ||
    typeof job.retryLimit !== "number" ||
    job.retryCount >= job.retryLimit;
  if (!final) return deliverDueReminder(scopedDb, job.data, deps);

  await sql`savepoint reminder_delivery`.execute(scopedDb.db);
  try {
    return await deliverDueReminder(scopedDb, job.data, deps);
  } catch {
    await sql`rollback to savepoint reminder_delivery`.execute(scopedDb.db);
    const reminder = await deps.reminders.lockForDelivery(scopedDb, job.data.resourceId);
    if (!reminder) return unlockedOutcome(scopedDb, job.data, deps);
    if (reminder.ownerUserId !== job.data.actorUserId) return "missing";
    await deps.reminders.markFailed(scopedDb, reminder.id);
    return "failed";
  }
}

/** The delivery worker needs retry metadata to recognise its last attempt. */
export function reminderDeliveryWorkOptions(overrides?: WorkOptions): WorkOptions {
  return {
    pollingIntervalSeconds: DATA_CONTEXT_WORKER_POLLING_INTERVAL_SECONDS,
    ...overrides,
    includeMetadata: true
  };
}

export async function registerReminderDeliveryWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  workOptions?: WorkOptions
): Promise<string> {
  const deps = { reminders: new ReminderRepository(), chat: new ChatRepository() };
  return registerDataContextWorker<DeliverReminderJobPayload, ReminderDeliveryOutcome>(
    boss,
    CHAT_DELIVER_REMINDER_QUEUE,
    dataContext,
    (job, scopedDb) => runReminderDeliveryJob(scopedDb, job, deps),
    reminderDeliveryWorkOptions(workOptions)
  );
}
