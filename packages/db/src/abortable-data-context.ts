import { Kysely, PostgresDialect } from "kysely";
import { DataContextRunner, type AccessContext, type DataContextDb } from "./data-context.js";
import type { MossDatabase } from "./types.js";
import type { AbortablePgPool } from "./abortable-pg-pool.js";

/** Owner-scoped transaction on a reusable lease; cancellation waits for local transport teardown. */
export async function withAbortableDataContext<T>(
  pool: AbortablePgPool,
  actor: AccessContext,
  signal: AbortSignal,
  work: (db: DataContextDb) => Promise<T>
): Promise<T> {
  return pool.withClient(signal, async (client) => {
    const database = new Kysely<MossDatabase>({
      dialect: new PostgresDialect({
        pool: {
          options: {},
          connect: async () => ({
            query: client.query.bind(client),
            release() {}
          }),
          // The outer lease owns release after Kysely finishes commit/rollback.
          end: async () => {}
        }
      })
    });
    try {
      return await new DataContextRunner(database).withDataContext(actor, async (db) => {
        signal.throwIfAborted();
        const result = await work(db);
        signal.throwIfAborted();
        return result;
      });
    } finally {
      await database.destroy();
    }
  });
}
