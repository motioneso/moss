import type { Client } from "pg";
/** A canonical writer can wait before its authored row-lock query gets a snapshot. */
export async function blockedFinanceWrites(
  observer: Client,
  authoredQueryPattern: string
): Promise<number> {
  const result = await observer.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() " +
      "AND state='active' AND wait_event_type='Lock' AND pid<>pg_backend_pid() " +
      "AND cardinality(pg_blocking_pids(pid))>0 " +
      "AND (query LIKE $1 OR query LIKE '%pg_advisory_xact_lock%')",
    [authoredQueryPattern]
  );
  return result.rows[0]!.n;
}
