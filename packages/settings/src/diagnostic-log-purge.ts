import { sql, type Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import type { PgBoss } from "@moss/jobs";
import { assertMetadataOnlyPayload } from "@moss/jobs";

export const DIAGNOSTIC_LOG_PURGE_QUEUE = "diagnostics.log_purge";
export const DIAGNOSTIC_LOG_PURGE_CRON = "43 * * * *";
const DIAGNOSTIC_LOG_PURGE_TZ = "UTC";
const DIAGNOSTIC_LOG_PURGE_KEY = "diagnostic-log-purge";

/** Retention targets. The hourly job enforces them, so the table can briefly exceed them. */
export const DIAGNOSTIC_LOG_MAX_AGE_DAYS = 7;
export const DIAGNOSTIC_LOG_MAX_ROWS = 50_000;

export interface DiagnosticLogPurgeJobPayload {
  kind: "diagnostics.log_purge";
}

export async function reconcileDiagnosticLogPurgeSchedule(boss: PgBoss): Promise<void> {
  const data: DiagnosticLogPurgeJobPayload = { kind: "diagnostics.log_purge" };
  assertMetadataOnlyPayload(data);
  await boss.schedule(DIAGNOSTIC_LOG_PURGE_QUEUE, DIAGNOSTIC_LOG_PURGE_CRON, data, {
    tz: DIAGNOSTIC_LOG_PURGE_TZ,
    key: DIAGNOSTIC_LOG_PURGE_KEY
  });
}

/** Runs the purge function as the worker role and returns the number of rows deleted. */
export async function purgeDiagnosticLog(workerDb: Kysely<MossDatabase>): Promise<number> {
  const result = await sql<{ deleted: number }>`
    SELECT app.purge_diagnostic_log(
      make_interval(days => ${DIAGNOSTIC_LOG_MAX_AGE_DAYS}),
      ${DIAGNOSTIC_LOG_MAX_ROWS}::integer
    ) AS deleted
  `.execute(workerDb);
  return Number(result.rows[0]?.deleted ?? 0);
}
