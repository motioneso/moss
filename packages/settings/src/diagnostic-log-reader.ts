import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import {
  LOG_MESSAGE_RETURN_MAX,
  type LogLevelName,
  type LogRecordObservation,
  type LogsSection
} from "@moss/module-sdk";

export interface ReadDiagnosticLogsOptions {
  readonly limit: number;
  readonly since: Date;
  readonly minLevel: LogLevelName;
  readonly component?: string;
  readonly connectionKind?: string;
}

interface LogRow {
  readonly occurred_at: Date | string;
  readonly process: "api" | "worker";
  readonly level: number;
  readonly component: string;
  readonly connection_kind: string | null;
  readonly event_code: string | null;
  readonly owned: boolean;
  readonly owner_known: boolean;
  readonly message: string | null;
}

interface CoverageRow {
  readonly oldest_at: Date | string | null;
  readonly newest_at: Date | string | null;
}

const LEVEL_NUMBER: Record<LogLevelName, number> = { warn: 40, error: 50, fatal: 60 };

function levelName(level: number): LogLevelName {
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  return "warn";
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * Reads stored warnings and errors through the two admin-checked database functions. The
 * functions return nothing to a non-admin and withhold message text from rows the caller does not
 * own. The stored context is never selected. Reads one row more than the limit to detect
 * truncation.
 */
export async function readDiagnosticLogs(
  scopedDb: DataContextDb,
  options: ReadDiagnosticLogsOptions
): Promise<LogsSection> {
  assertDataContextDb(scopedDb);
  const limit = Math.max(1, Math.min(10, Math.floor(options.limit)));
  const rows = await sql<LogRow>`
    SELECT occurred_at, process, level, component, connection_kind, event_code,
           owned, owner_known, message
    FROM app.read_diagnostic_log(
      ${options.since.toISOString()}::timestamptz,
      ${LEVEL_NUMBER[options.minLevel]}::smallint,
      ${options.component ?? null}::text,
      ${options.connectionKind ?? null}::text,
      ${limit + 1}::integer
    )
  `.execute(scopedDb.db);
  const coverage = await sql<CoverageRow>`
    SELECT oldest_at, newest_at FROM app.diagnostic_log_coverage()
  `.execute(scopedDb.db);

  const records: LogRecordObservation[] = rows.rows.slice(0, limit).map((row) => ({
    occurredAt: iso(row.occurred_at) ?? "",
    process: row.process,
    level: levelName(Number(row.level)),
    component: row.component,
    connectionKind: row.connection_kind,
    eventCode: row.event_code,
    ownerKnown: row.owner_known,
    owned: row.owned,
    message:
      row.owned && row.message !== null ? row.message.slice(0, LOG_MESSAGE_RETURN_MAX) : null,
    truncated: false
  }));
  const cov = coverage.rows[0];
  return {
    records,
    coverage: { oldestAt: iso(cov?.oldest_at ?? null), newestAt: iso(cov?.newest_at ?? null) },
    truncated: rows.rows.length > limit
  };
}
