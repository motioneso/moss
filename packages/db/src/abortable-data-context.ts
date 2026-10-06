import { Kysely, PostgresDialect } from "kysely";
import { DataContextRunner, type AccessContext, type DataContextDb } from "./data-context.js";
import type { MossDatabase } from "./types.js";
import { withOwnedPgClient } from "./owned-pg-client.js";

/** Abort closes the owned transport; commit/rollback and socket cleanup finish before returning. */
export async function withAbortableDataContext<T>(
  connectionString: string,
  actor: AccessContext,
  signal: AbortSignal,
  work: (db: DataContextDb) => Promise<T>
): Promise<T> {
  return withOwnedPgClient(
    {
      connectionString,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      idle_in_transaction_session_timeout: 3000,
      application_name: "moss-abortable-data-context"
    },
    signal,
    async (client) => {
      const database = new Kysely<MossDatabase>({
        dialect: new PostgresDialect({
          pool: {
            options: {},
            connect: async () => Object.assign(client, { release() {} }),
            // withOwnedPgClient owns transport teardown after Kysely releases its connection.
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
    }
  );
}
