import { CompiledQuery, sql } from "kysely";
import type { DataContextDb } from "./data-context.js";
import { moduleRuntimeRoleName } from "./module-role-broker.js";
import { classifyModuleStatement, ModuleQueryError } from "./module-statement-classify.js";

// #1167 (#914 D5): the ONLY door module-authored SQL may pass through. The
// statement allowlist and error redaction are unconditional; timeout and
// row/byte caps default on and can be disabled (null) only by platform-side
// callers (data export needs unbounded reads).

export const MODULE_QUERY_STATEMENT_TIMEOUT_MS = 5_000;
export const MODULE_QUERY_ROW_CAP = 5_000;
export const MODULE_QUERY_RESULT_BYTE_CAP = 5 * 1024 * 1024;

export interface ModuleQueryResult<T> {
  readonly rows: readonly T[];
}

export interface ModuleStorageRpc {
  query<T = Record<string, unknown>>(
    queryText: string,
    params?: readonly unknown[]
  ): Promise<ModuleQueryResult<T>>;
}

export interface ModuleQueryBounds {
  /** Reject anything but SELECT (read-risk tools). Default false. */
  readonly readOnly?: boolean;
  /** SET LOCAL statement_timeout in ms; null disables. Default 5000. */
  readonly statementTimeoutMs?: number | null;
  /** Max returned rows (error, not truncation); null disables. Default 5000. */
  readonly rowCap?: number | null;
  /** Max JSON-serialized result bytes; null disables. Default 5 MiB. */
  readonly resultByteCap?: number | null;
}

/** SQLSTATE is 5 chars from [0-9A-Z]; anything else is not a pg error code. */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function redactedQueryError(error: unknown): ModuleQueryError {
  const candidate = error as { code?: unknown; message?: unknown };
  const sqlstate =
    typeof candidate.code === "string" && SQLSTATE_PATTERN.test(candidate.code)
      ? candidate.code
      : undefined;
  // node-postgres puts ONLY the primary message on .message — the data-bearing
  // fields (detail, hint, where) are separate properties and are dropped here
  // by construction. The primary message may echo tokens from the module's own
  // query text; only the authoring module's host-side consumers read it.
  const message = typeof candidate.message === "string" ? candidate.message : "query failed";
  return new ModuleQueryError("db_query_failed", message, sqlstate);
}

function assertBound(name: string, value: number | null): void {
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`createModuleStorageRpc: invalid ${name}: ${value}`);
  }
}

export function createModuleStorageRpc(
  scopedDb: DataContextDb,
  moduleId: string,
  bounds: ModuleQueryBounds = {}
): ModuleStorageRpc {
  const role = moduleRuntimeRoleName(moduleId);
  const readOnly = bounds.readOnly ?? false;
  const timeoutMs =
    bounds.statementTimeoutMs === undefined
      ? MODULE_QUERY_STATEMENT_TIMEOUT_MS
      : bounds.statementTimeoutMs;
  const rowCap = bounds.rowCap === undefined ? MODULE_QUERY_ROW_CAP : bounds.rowCap;
  const resultByteCap =
    bounds.resultByteCap === undefined ? MODULE_QUERY_RESULT_BYTE_CAP : bounds.resultByteCap;
  assertBound("statementTimeoutMs", timeoutMs);
  assertBound("rowCap", rowCap);
  assertBound("resultByteCap", resultByteCap);
  return {
    async query<T = Record<string, unknown>>(
      queryText: string,
      params: readonly unknown[] = []
    ): Promise<ModuleQueryResult<T>> {
      const kind = classifyModuleStatement(queryText);
      if (readOnly && kind !== "select") {
        throw new ModuleQueryError(
          "forbidden_mutation",
          `${kind} is not allowed from a read-only tool`
        );
      }
      await sql.raw(`SET LOCAL ROLE ${role}`).execute(scopedDb.db);
      if (timeoutMs !== null) {
        // Value is a validated positive integer — safe to inline; ms units.
        await sql.raw(`SET LOCAL statement_timeout = ${timeoutMs}`).execute(scopedDb.db);
      }
      let result;
      try {
        result = await scopedDb.db.executeQuery<T>(CompiledQuery.raw(queryText, [...params]));
      } catch (error) {
        throw redactedQueryError(error);
      } finally {
        try {
          await sql.raw("RESET ROLE").execute(scopedDb.db);
        } catch {
          // Same reasoning as the statement_timeout reset below: an aborted
          // transaction takes the role with it on rollback.
        }
        if (timeoutMs !== null) {
          try {
            await sql.raw("SET LOCAL statement_timeout TO DEFAULT").execute(scopedDb.db);
          } catch {
            // A timed-out statement aborts the transaction; the SET LOCAL
            // dies with the rollback anyway.
          }
        }
      }
      if (rowCap !== null && result.rows.length > rowCap) {
        throw new ModuleQueryError("row_cap_exceeded", `query returned more than ${rowCap} rows`);
      }
      if (resultByteCap !== null) {
        const bytes = Buffer.byteLength(JSON.stringify(result.rows), "utf8");
        if (bytes > resultByteCap) {
          throw new ModuleQueryError(
            "result_byte_cap_exceeded",
            `result exceeds ${resultByteCap} bytes`
          );
        }
      }
      return { rows: result.rows };
    }
  };
}
