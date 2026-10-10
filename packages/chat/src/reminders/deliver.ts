// #3309: puts one due reminder into its owner's Main chat, once. The job only names the
// reminder; every fact the delivery depends on is re-read under the row lock.

import type { PgBoss, WorkOptions } from "pg-boss";

import type { DataContextDb, DataContextRunner } from "@moss/db";
import {
  registerDataContextWorker,
  scopedJobDatabase,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";

import { ChatRepository } from "../repository.js";
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
  | "stale_version"
  | "not_main";

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
  deps: { readonly reminders: ReminderRepository; readonly chat: ChatRepository }
): Promise<ReminderDeliveryOutcome> {
  const reminder = await deps.reminders.lockForDelivery(scopedDb, payload.resourceId);

  // The worker can lock only queued rows, so a delivered row reads back unlocked.
  if (!reminder) {
    const current = await deps.reminders.readState(scopedDb, payload.resourceId);
    return current?.ownerUserId === payload.actorUserId ? "already_delivered" : "missing";
  }
  if (reminder.ownerUserId !== payload.actorUserId) return "missing";
  if (reminder.state !== "queued") return "already_delivered";
  if (reminder.version !== payload.version) return "stale_version";

  const now = await deps.reminders.now(scopedDb);

  // A job that runs early fails and retries, so it can never deliver before the due time.
  if (now.getTime() < reminder.dueAt.getTime()) {
    throw new Error("chat reminder delivery ran before its due time");
  }

  const main = await deps.chat.getMainThread(scopedDb, reminder.ownerUserId);
  if (!main || main.id !== reminder.threadId) return "not_main";

  const late = now.getTime() - reminder.dueAt.getTime() > REMINDER_LATE_AFTER_MS;
  await deps.chat.insertReservedAssistantMessage(scopedDb, {
    id: reminder.reservedMessageId,
    threadId: reminder.threadId,
    body: reminderDeliveredMessage(reminder.text, late),
    origin: { version: 1, kind: "reminder", event: "delivered", reminderId: reminder.id, late },
    now
  });
  await deps.reminders.markDelivered(scopedDb, reminder.id, late);
  return "delivered";
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
    (job, scopedDb) => deliverDueReminder(scopedDb, job.data, deps),
    workOptions
  );
}
