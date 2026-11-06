/**
 * Shapes for the admin-only `jobs` and `connections` sections of platform diagnostics.
 * They live here so the job reader (@moss/jobs), the connection reader (@moss/connectors) and
 * the service (@moss/ai) agree on one contract without importing each other.
 */

/** Maximum length of any label string in these sections. */
export const DIAGNOSTIC_LABEL_MAX = 120;

/** Maximum items in any list in these sections, matching the service limit. */
export const DIAGNOSTIC_LIST_MAX = 10;

/** One recent job run. `kind` and `connectorAccountId` are null unless the caller owns the row. */
export interface JobRunObservation {
  readonly occurredAt: string;
  readonly queue: string;
  readonly state: string;
  readonly retryCount: number;
  readonly ownerKnown: boolean;
  readonly kind: string | null;
  readonly connectorAccountId: string | null;
  readonly errorLabel: string | null;
}

/** Per-queue totals over the look-back window. */
export interface JobSummaryObservation {
  readonly queue: string;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly failedLast24h: number;
  readonly stuckCount: number;
  readonly activeCount: number;
}

export interface JobsSection {
  readonly recent: readonly JobRunObservation[];
  readonly summaries: readonly JobSummaryObservation[];
  readonly truncated: boolean;
}

export interface ConnectionObservation {
  readonly provider: string;
  readonly accountId: string;
  readonly status: string;
  readonly lastAttemptAt: string | null;
  readonly lastGoodAt: string | null;
  readonly failureCount: number;
  readonly errorLabel: string | null;
}

export interface ConnectionsSection {
  readonly items: readonly ConnectionObservation[];
  readonly truncated: boolean;
}

export const EMPTY_JOBS_SECTION: JobsSection = { recent: [], summaries: [], truncated: false };
export const EMPTY_CONNECTIONS_SECTION: ConnectionsSection = { items: [], truncated: false };

export type LogLevelName = "warn" | "error" | "fatal";

/** One stored warning or error. `message` is null unless the caller owns the record. */
export interface LogRecordObservation {
  readonly occurredAt: string;
  readonly process: "api" | "worker";
  readonly level: LogLevelName;
  readonly component: string;
  readonly connectionKind: string | null;
  readonly eventCode: string | null;
  readonly ownerKnown: boolean;
  readonly owned: boolean;
  readonly message: string | null;
  readonly truncated: boolean;
}

export interface LogsSection {
  readonly records: readonly LogRecordObservation[];
  readonly coverage: { readonly oldestAt: string | null; readonly newestAt: string | null };
  readonly truncated: boolean;
}

/** Maximum characters of a log message returned to the caller. */
export const LOG_MESSAGE_RETURN_MAX = 500;

export const EMPTY_LOGS_SECTION: LogsSection = {
  records: [],
  coverage: { oldestAt: null, newestAt: null },
  truncated: false
};
