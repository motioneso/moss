import { getOwnedPgClientConstructor, type DataContextDb, type OwnedPgClient } from "@moss/db";
import { sql } from "kysely";
import type { PgBoss } from "./pg-boss.js";

export const JOB_QUEUE_WAKEUP_CHANNEL = "moss_job_queue_ready";

/** PostgreSQL publishes this queue-name-only hint when the scheduling transaction commits. */
export async function notifyJobQueue(db: DataContextDb, queue: string): Promise<void> {
  await sql`select pg_notify(${JOB_QUEUE_WAKEUP_CHANNEL}, ${queue})`.execute(db.db);
}

/** Wake the normal pg-boss fetch loop; polling remains authoritative after missed hints. */
export function startJobQueueWakeup(
  connectionString: string,
  queue: string,
  boss: Pick<PgBoss, "notifyWorker">,
  workerIds: readonly string[],
  options: {
    readonly retryMs?: number;
    readonly createClient?: () => OwnedPgClient;
  } = {}
): { readonly ready: Promise<void>; stop(): Promise<void> } {
  const createClient =
    options.createClient ??
    (() =>
      new (getOwnedPgClientConstructor())({
        connectionString,
        connectionTimeoutMillis: 5000,
        keepAlive: true
      }));
  let stopped = false;
  let client: OwnedPgClient | undefined;
  let retry: NodeJS.Timeout | undefined;
  let connecting: Promise<void> = Promise.resolve();
  let closing: Promise<void> = Promise.resolve();

  const scheduleRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      connecting = connect();
    }, options.retryMs ?? 5000);
    retry.unref();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = createClient();
    client = next;
    next.on("notification", (notification) => {
      if (
        !stopped &&
        client === next &&
        notification.channel === JOB_QUEUE_WAKEUP_CHANNEL &&
        notification.payload === queue
      )
        for (const id of workerIds) boss.notifyWorker(id);
    });
    const lost = () => {
      if (client !== next) return;
      client = undefined;
      closing = next.end().catch(() => undefined);
      scheduleRetry();
    };
    next.once("error", lost);
    next.once("end", lost);
    try {
      await next.connect();
      await next.query(`LISTEN ${JOB_QUEUE_WAKEUP_CHANNEL}`);
      // An enqueue between work registration and LISTEN is recovered immediately too.
      if (!stopped && client === next) for (const id of workerIds) boss.notifyWorker(id);
    } catch {
      lost();
    }
  };

  const ready = connect();
  connecting = ready;
  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(retry);
      await connecting;
      await closing;
      const current = client;
      client = undefined;
      await current?.end().catch(() => undefined);
    }
  };
}
