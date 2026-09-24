import { sql } from "kysely";

import type { DataContextDb } from "./data-context.js";

let savepointCounter = 0;

/**
 * Runs `work` inside a SAVEPOINT on the scoped transaction. A database error swallowed by a
 * catch would otherwise leave the transaction aborted (25P02) and fail every later statement.
 * On any error the savepoint is rolled back and released, and the error is rethrown.
 *
 * Savepoints nest but must not interleave, so never run two of these concurrently on the
 * same transaction.
 */
export async function withSavepoint<T>(
  scopedDb: DataContextDb,
  work: () => Promise<T>
): Promise<T> {
  savepointCounter += 1;
  const name = `moss_sp_${savepointCounter}`;
  await sql.raw(`SAVEPOINT ${name}`).execute(scopedDb.db);
  try {
    const result = await work();
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(scopedDb.db);
    return result;
  } catch (error) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(scopedDb.db);
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(scopedDb.db);
    throw error;
  }
}
