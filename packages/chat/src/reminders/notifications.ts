import type { PgBoss, WorkOptions } from "pg-boss";

import { isUuid, type DataContextDb, type DataContextRunner } from "@moss/db";
import {
  registerDataContextWorker,
  scopedJobDatabase,
  sendJob,
  type ActorScopedJobPayload
} from "@moss/jobs";
import {
  type NotificationsRepository,
  PUSH_QUEUE_RETRY_OPTIONS,
  type NotificationWithReadState
} from "@moss/notifications";

import { ReminderRepository, type DueReminder } from "./repository.js";

export const CHAT_NOTIFY_REMINDER_QUEUE = "chat.notify-reminder";
export const CHAT_NOTIFY_REMINDER_QUEUE_DEFINITION = {
  name: CHAT_NOTIFY_REMINDER_QUEUE,
  options: PUSH_QUEUE_RETRY_OPTIONS
};

export interface ReminderNotificationPayload extends ActorScopedJobPayload {
  readonly resourceId: string;
  readonly version: number;
  readonly idempotencyKey: string;
}

export async function enqueueReminderNotification(
  boss: Pick<PgBoss, "send">,
  scopedDb: DataContextDb,
  reminder: DueReminder
): Promise<void> {
  await sendJob<ReminderNotificationPayload>(
    boss,
    CHAT_NOTIFY_REMINDER_QUEUE,
    {
      actorUserId: reminder.ownerUserId,
      resourceId: reminder.id,
      version: reminder.version,
      idempotencyKey: reminder.reservedMessageId
    },
    { db: scopedJobDatabase(scopedDb) }
  );
}

export async function runReminderNotificationJob(
  scopedDb: DataContextDb,
  payload: ReminderNotificationPayload,
  notifications: NotificationsRepository
): Promise<"created" | "already_created" | "inactive" | "muted"> {
  const result = await new ReminderRepository().readNotificationResult(
    scopedDb,
    payload.resourceId
  );
  if (
    !result ||
    result.ownerUserId !== payload.actorUserId ||
    result.version !== payload.version ||
    result.messageId !== payload.idempotencyKey
  )
    return "inactive";
  if (await notifications.findByEventKey(scopedDb, "chat", payload.idempotencyKey))
    return "already_created";
  const notification = await notifications.create(scopedDb, {
    moduleId: "chat",
    title: "Reminder from Moss",
    body: result.body,
    urgency: "normal",
    eventKey: result.messageId,
    href: "/today",
    metadata: { kind: "chat_reminder", reminderId: payload.resourceId, messageId: result.messageId }
  });
  return notification ? "created" : "muted";
}

/** Source lifecycle belongs to chat; push workers only consume this public check. */
export async function isReminderNotificationActive(
  scopedDb: DataContextDb,
  notification: NotificationWithReadState
): Promise<boolean> {
  if (notification.module_id !== "chat" || notification.metadata.kind !== "chat_reminder")
    return true;
  const { reminderId, messageId } = notification.metadata;
  if (typeof reminderId !== "string" || !isUuid(reminderId) || typeof messageId !== "string")
    return false;
  const result = await new ReminderRepository().readNotificationResult(scopedDb, reminderId);
  return result?.messageId === messageId;
}

export function registerReminderNotificationWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  notifications: NotificationsRepository,
  workOptions?: WorkOptions
): Promise<string> {
  return registerDataContextWorker<ReminderNotificationPayload, string>(
    boss,
    CHAT_NOTIFY_REMINDER_QUEUE,
    dataContext,
    (job, scopedDb) => runReminderNotificationJob(scopedDb, job.data, notifications),
    workOptions
  );
}
