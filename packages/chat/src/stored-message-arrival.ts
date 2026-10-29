import { sql } from "kysely";
import {
  getOwnedPgClientConstructor,
  isUuid,
  type DataContextDb,
  type OwnedPgClient
} from "@moss/db";
import type { BackgroundMessage } from "./live/background-message-routing.js";
import { asRecord } from "./route-serializers.js";

/** IDs only: notification channels are visible to every database role. */
export interface StoredMessageArrival {
  readonly actorUserId: string;
  readonly threadId: string;
  readonly messageId: string;
}

const RETRY_MS = 5_000;
const CONNECT_TIMEOUT_MS = 10_000;

function isId(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

export async function notifyStoredMessageArrival(
  scopedDb: DataContextDb,
  channel: string,
  arrival: StoredMessageArrival
): Promise<void> {
  const payload = JSON.stringify({
    actorUserId: arrival.actorUserId,
    threadId: arrival.threadId,
    messageId: arrival.messageId
  });
  await sql`select pg_notify(${channel}, ${payload})`.execute(scopedDb.db);
}

export function parseStoredMessageArrival(
  payload: string | undefined
): StoredMessageArrival | undefined {
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

export interface StoredMessageArrivalListener {
  /** Resolves once the channel is listened on, or after the first failed attempt. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Holds one listening connection and reconnects after a drop. A reminder delivered while the
 * connection is down is not pushed; the browser shows it from history on its next read.
 */
export function startStoredMessageArrivalListener(deps: {
  readonly connectionString: string;
  readonly channel: string;
  readonly label: string;
  readonly read: (arrival: StoredMessageArrival) => Promise<BackgroundMessage | undefined>;
  readonly deliver: (message: BackgroundMessage) => Promise<void>;
  readonly warn: (error: unknown, message: string) => void;
  readonly retryMs?: number;
  readonly createClient?: (connectionString: string) => OwnedPgClient;
}): StoredMessageArrivalListener {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(deps.channel)) throw new Error("Invalid arrival channel");
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
    const arrival = parseStoredMessageArrival(payload);
    if (!arrival) return;
    queue = queue
      .then(async () => {
        const message = await deps.read(arrival);
        if (message && !stopped) await deps.deliver(message);
      })
      .catch((error: unknown) => deps.warn(error, `${deps.label} read failed`));
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
      if (notification.channel === deps.channel) handle(notification.payload);
    });
    next.once("end", () => {
      if (client === next) {
        client = undefined;
        if (!stopped) deps.warn(undefined, `${deps.label} listener lost its connection`);
      }
      scheduleRetry();
    });
    try {
      await next.connect();
      await next.query(`LISTEN ${deps.channel}`);
      client = next;
      if (stopped) await next.end();
    } catch (error) {
      deps.warn(error, `${deps.label} listener could not connect`);
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
