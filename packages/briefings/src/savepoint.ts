import { sql } from "kysely";
import type { DataContextDb } from "@moss/db";

let toolSavepointCounter = 0;

/**
 * Runs one best-effort step inside a SAVEPOINT. Compose shares the job's single transaction, so a
 * database error swallowed by a catch would otherwise abort every later statement (25P02) and
 * fail the whole run. Callers must not run two of these concurrently on the same transaction.
 */
export async function withToolSavepoint<T>(
  scopedDb: DataContextDb,
  work: () => Promise<T>
): Promise<T> {
  toolSavepointCounter += 1;
  const name = `briefing_tool_sp_${toolSavepointCounter}`;
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
