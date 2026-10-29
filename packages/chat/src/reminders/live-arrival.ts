// Committed reminder arrivals carry IDs only. The API re-reads the destination and message
// under owner access; the server and browser both filter by the shown thread.

import type { FastifyInstance } from "fastify";

import { type DataContextDb, type DataContextRunner, type OwnedPgClient } from "@moss/db";

import type { BackgroundMessage } from "../live/background-message-routing.js";
import type { ChatSessionManager } from "../live/chat-session-manager.js";
import { ChatRepository } from "../repository.js";
import { asRecord, readOrigin, readScheduledReadSource } from "../route-serializers.js";

import {
  parseStoredMessageArrival,
  notifyStoredMessageArrival,
  startStoredMessageArrivalListener,
  type StoredMessageArrivalListener
} from "../stored-message-arrival.js";

export const REMINDER_ARRIVAL_CHANNEL = "moss_chat_reminder_arrival";

/** Ids only. Any database role can listen on a channel, so it never carries reminder text. */
export interface ReminderArrival {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly messageId: string;
}

export const parseReminderArrival = parseStoredMessageArrival;
export async function notifyReminderArrival(
  db: DataContextDb,
  arrival: ReminderArrival
): Promise<void> {
  await notifyStoredMessageArrival(db, REMINDER_ARRIVAL_CHANNEL, arrival);
}

/**
 * Re-reads a notified reminder as the named owner. Any role can notify, so the checks below
 * accept only a stored delivered reminder that the owner wrote into the owner's own Main thread.
 * A forged payload can at most re-send that owner's own reminder to that owner, which the
 * browser drops as a duplicate.
 */
export async function readReminderArrival(
  dataContext: DataContextRunner,
  arrival: ReminderArrival,
  chat: ChatRepository = new ChatRepository()
): Promise<BackgroundMessage | undefined> {
  const { actorUserId } = arrival;
  return dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
    const target = await chat.getOwnedThreadById(scopedDb, actorUserId, arrival.threadId);
    if (
      !target ||
      target.incognito ||
      target.surface !== "drawer" ||
      target.id !== arrival.threadId
    )
      return undefined;
    const message = await chat.getMessageById(scopedDb, arrival.messageId);
    if (
      !message ||
      message.owner_user_id !== actorUserId ||
      message.thread_id !== target.id ||
      message.role !== "assistant" ||
      message.status !== "stored"
    )
      return undefined;
    const origin = readOrigin(asRecord(message.model_metadata).origin);
    if (origin?.kind !== "reminder" || origin.event !== "delivered") return undefined;
    return {
      actorUserId,
      threadId: target.id,
      record: {
        kind: "reply",
        text: message.body,
        messageId: message.id,
        background: true,
        scheduledReadSource: readScheduledReadSource(asRecord(message.model_metadata)),
        backgroundThreadId: target.id
      }
    };
  });
}

export type ReminderArrivalListener = StoredMessageArrivalListener;

/** Retains the reminder-only public channel and read contract. */
export function startReminderArrivalListener(deps: {
  readonly connectionString: string;
  readonly read: (arrival: ReminderArrival) => Promise<BackgroundMessage | undefined>;
  readonly deliver: (message: BackgroundMessage) => Promise<void>;
  readonly warn: (error: unknown, message: string) => void;
  readonly retryMs?: number;
  readonly createClient?: (connectionString: string) => OwnedPgClient;
}): ReminderArrivalListener {
  return startStoredMessageArrivalListener({
    ...deps,
    channel: REMINDER_ARRIVAL_CHANNEL,
    label: "reminder arrival"
  });
}

/** Listens from server ready to server close. Without a connection string nothing listens. */
export function registerReminderArrivalLifecycle(
  server: FastifyInstance,
  deps: {
    readonly connectionString?: string;
    readonly dataContext: DataContextRunner;
    readonly manager: Pick<ChatSessionManager, "deliverBackgroundMessage">;
  }
): void {
  const { connectionString } = deps;
  if (!connectionString) return;
  let listener: ReminderArrivalListener | undefined;
  server.addHook("onReady", async () => {
    listener = startReminderArrivalListener({
      connectionString,
      read: (arrival) => readReminderArrival(deps.dataContext, arrival),
      deliver: (message) => deps.manager.deliverBackgroundMessage(message),
      warn: (err, message) => server.log.warn({ err }, message)
    });
    await listener.ready;
  });
  server.addHook("onClose", async () => {
    await listener?.stop();
  });
}
