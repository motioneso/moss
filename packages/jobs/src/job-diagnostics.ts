import { sql, type Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";
import {
  DIAGNOSTIC_LABEL_MAX,
  type JobRunObservation,
  type JobsSection,
  type JobSummaryObservation
} from "@moss/module-sdk";

export interface ReadJobDiagnosticsOptions {
  readonly actorUserId: string;
  readonly limit: number;
  /** Only queues whose name starts with this prefix are read. */
  readonly queuePrefix?: string;
  /** Start of the look-back window for recent runs and the failure count. */
  readonly since: Date;
  /** Age in seconds after which an active or overdue waiting job counts as stuck. Default 900. */
  readonly stuckAfterSeconds?: number;
}

interface RecentRow {
  readonly name: string;
  readonly state: string;
  readonly retry_count: number;
  readonly occurred_at: Date;
  readonly owned: boolean;
  readonly kind: string | null;
  readonly connector_account_id: string | null;
  readonly error_label: string | null;
}

interface SummaryRow {
  readonly name: string;
  readonly last_success: Date | null;
  readonly last_failure: Date | null;
  readonly failed_recent: string | number;
  readonly stuck: string | number;
  readonly active: string | number;
}

function label(value: string | null): string | null {
  return value === null ? null : value.slice(0, DIAGNOSTIC_LABEL_MAX);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Reads recent job runs and per-queue totals for the platform diagnostics tool.
 *
 * Privacy rules are enforced in the SQL projection, because the database gives no per-user
 * protection on pgboss.job. The payload is never selected whole: only the three keys
 * actorUserId, kind and connectorAccountId are read, and kind and connectorAccountId leave the
 * query only for rows the caller owns. The output column is never selected, and the error label
 * is a fixed word derived from the job state. Admins get no exception.
 */
export async function readJobDiagnostics(
  db: Kysely<MossDatabase>,
  options: ReadJobDiagnosticsOptions
): Promise<JobsSection> {
  const limit = Math.max(1, Math.min(10, Math.floor(options.limit)));
  const stuckCutoff = new Date(Date.now() - (options.stuckAfterSeconds ?? 900) * 1000);
  const prefix = options.queuePrefix
    ? sql`and name like ${`${escapeLike(options.queuePrefix)}%`}`
    : sql``;

  const recent = await sql<RecentRow>`
    select
      name,
      state::text as state,
      retry_count,
      coalesce(completed_on, started_on, created_on) as occurred_at,
      coalesce(data->>'actorUserId' = ${options.actorUserId}, false) as owned,
      case when data->>'actorUserId' = ${options.actorUserId} then data->>'kind' end as kind,
      case when data->>'actorUserId' = ${options.actorUserId}
        then data->>'connectorAccountId' end as connector_account_id,
      case state::text
        when 'failed' then 'failed'
        when 'retry' then 'retrying'
        when 'cancelled' then 'cancelled'
        else null
      end as error_label
    from pgboss.job
    where coalesce(completed_on, started_on, created_on) >= ${options.since}
      ${prefix}
    order by coalesce(completed_on, started_on, created_on) desc
    limit ${limit + 1}
  `.execute(db);

  const summaries = await sql<SummaryRow>`
    select
      name,
      max(completed_on) filter (where state::text = 'completed') as last_success,
      max(coalesce(completed_on, started_on, created_on)) filter (where state::text = 'failed')
        as last_failure,
      count(*) filter (
        where state::text = 'failed'
          and coalesce(completed_on, started_on, created_on) >= ${options.since}
      ) as failed_recent,
      count(*) filter (
        where (state::text = 'active' and started_on < ${stuckCutoff})
          or (state::text in ('created', 'retry') and start_after < ${stuckCutoff})
      ) as stuck,
      count(*) filter (where state::text = 'active') as active
    from pgboss.job
    where true ${prefix}
    group by name
    order by
      (count(*) filter (
        where state::text = 'failed'
          and coalesce(completed_on, started_on, created_on) >= ${options.since}
      )) desc,
      name
    limit ${limit + 1}
  `.execute(db);

  const recentRows = recent.rows.slice(0, limit);
  const summaryRows = summaries.rows.slice(0, limit);

  return {
    recent: recentRows.map(
      (row): JobRunObservation => ({
        occurredAt: iso(row.occurred_at) ?? "",
        queue: label(row.name) ?? "",
        state: row.state,
        retryCount: Number(row.retry_count),
        ownerKnown: row.owned === true,
        kind: label(row.kind),
        connectorAccountId: label(row.connector_account_id),
        errorLabel: row.error_label
      })
    ),
    summaries: summaryRows.map(
      (row): JobSummaryObservation => ({
        queue: label(row.name) ?? "",
        lastSuccessAt: iso(row.last_success),
        lastFailureAt: iso(row.last_failure),
        failedLast24h: Number(row.failed_recent),
        stuckCount: Number(row.stuck),
        activeCount: Number(row.active)
      })
    ),
    truncated: recent.rows.length > limit || summaries.rows.length > limit
  };
}
