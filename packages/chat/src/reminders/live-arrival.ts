// #3195: a delivered reminder appears in the owner's open Main chat at once. The delivery
// worker runs in another process, so it sends ids on a Postgres channel inside the delivery
// transaction, and Postgres delivers a notification only when that transaction commits. The
// API listens, re-reads the message under the owner's own access rules, and hands it to the
// session manager, which shows it only on the owner's drawer while it is on Main.

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";

import {
  getOwnedPgClientConstructor,
  isUuid,
  type DataContextDb,
  type DataContextRunner,
  type OwnedPgClient
} from "@moss/db";

import type { MainBackgroundMessage } from "../live/background-message-routing.js";
import type { ChatSessionManager } from "../live/chat-session-manager.js";
import { ChatRepository } from "../repository.js";
import { asRecord, readOrigin } from "../route-serializers.js";

export const REMINDER_ARRIVAL_CHANNEL = "moss_chat_reminder_arrival";

/** Ids only. Any database role can listen on a channel, so it never carries reminder text. */
export interface ReminderArrival {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly messageId: string;
}

const RETRY_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

function isId(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

export async function notifyReminderArrival(
  scopedDb: DataContextDb,
  arrival: ReminderArrival
): Promise<void> {
  const payload = JSON.stringify({
    actorUserId: arrival.actorUserId,
    threadId: arrival.threadId,
    messageId: arrival.messageId
  });
  await sql`select pg_notify(${REMINDER_ARRIVAL_CHANNEL}, ${payload})`.execute(scopedDb.db);
}

export function parseReminderArrival(payload: string | undefined): ReminderArrival | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload ?? "");
  } catch {
    return undefined;
  }
  const { actorUserId, threadId, messageId } = asRecord(value);
  if (!isId(actorUserId) || !isId(threadId) || !isId(messageId)) return undefined;
  return { actorUserId, threadId, messageId };
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
): Promise<MainBackgroundMessage | undefined> {
  const { actorUserId } = arrival;
  return dataContext.withDataContext({ actorUserId }, async (scopedDb) => {
    const main = await chat.getMainThread(scopedDb, actorUserId);
    if (!main || main.incognito || main.id !== arrival.threadId) return undefined;
    const message = await chat.getMessageById(scopedDb, arrival.messageId);
    if (
      !message ||
      message.owner_user_id !== actorUserId ||
      message.thread_id !== main.id ||
      message.role !== "assistant" ||
      message.status !== "stored"
    )
      return undefined;
    const origin = readOrigin(asRecord(message.model_metadata).origin);
    if (origin?.kind !== "reminder" || origin.event !== "delivered") return undefined;
    return {
      actorUserId,
      mainThreadId: main.id,
      record: { kind: "reply", text: message.body, messageId: message.id, background: true }
    };
  });
}

export interface ReminderArrivalListener {
  /** Resolves once the channel is listened on, or after the first failed attempt. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Holds one listening connection and reconnects after a drop. A reminder delivered while the
 * connection is down is not pushed; the browser shows it from history on its next read.
 */
export function startReminderArrivalListener(deps: {
  readonly connectionString: string;
  readonly read: (arrival: ReminderArrival) => Promise<MainBackgroundMessage | undefined>;
  readonly deliver: (message: MainBackgroundMessage) => Promise<void>;
  readonly warn: (error: unknown, message: string) => void;
  readonly retryMs?: number;
  readonly createClient?: (connectionString: string) => OwnedPgClient;
}): ReminderArrivalListener {
  const createClient =
    deps.createClient ??
    ((connectionString: string) =>
      new (getOwnedPgClientConstructor())({
        connectionString,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        keepAlive: true
      }));
  let stopped = false;
  let client: OwnedPgClient | undefined;
  let retry: NodeJS.Timeout | undefined;
  let connecting: Promise<void> = Promise.resolve();
  let queue = Promise.resolve();

  const handle = (payload: string | undefined) => {
    const arrival = parseReminderArrival(payload);
    if (!arrival) return;
    queue = queue
      .then(async () => {
        const message = await deps.read(arrival);
        if (message && !stopped) await deps.deliver(message);
      })
      .catch((error: unknown) => deps.warn(error, "reminder arrival read failed"));
  };

  const scheduleRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connecting = connect();
    }, deps.retryMs ?? RETRY_MS);
    retry.unref?.();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = createClient(deps.connectionString);
    next.on("notification", (notification) => {
      if (notification.channel === REMINDER_ARRIVAL_CHANNEL) handle(notification.payload);
    });
    next.once("end", () => {
      if (client === next) {
        client = undefined;
        if (!stopped) deps.warn(undefined, "reminder arrival listener lost its connection");
      }
      scheduleRetry();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${REMINDER_ARRIVAL_CHANNEL}`);
      client = next;
      if (stopped) await next.end();
    } catch (error) {
      deps.warn(error, "reminder arrival listener could not connect");
      await next.end().catch(() => undefined);
      scheduleRetry();
    }
  };

  const ready = connect();
  connecting = ready;
  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(retry);
      retry = undefined;
      await connecting;
      await client?.end().catch(() => undefined);
      client = undefined;
      await queue;
    }
  };
}

/** Listens from server ready to server close. Without a connection string nothing listens. */
export function registerReminderArrivalLifecycle(
  server: FastifyInstance,
  deps: {
    readonly connectionString?: string;
    readonly dataContext: DataContextRunner;
    readonly manager: Pick<ChatSessionManager, "deliverMainBackgroundMessage">;
  }
): void {
  const { connectionString } = deps;
  if (!connectionString) return;
  let listener: ReminderArrivalListener | undefined;
  server.addHook("onReady", async () => {
    listener = startReminderArrivalListener({
      connectionString,
      read: (arrival) => readReminderArrival(deps.dataContext, arrival),
      deliver: (message) => deps.manager.deliverMainBackgroundMessage(message),
      warn: (err, message) => server.log.warn({ err }, message)
    });
    await listener.ready;
  });
  server.addHook("onClose", async () => {
    await listener?.stop();
  });
}
