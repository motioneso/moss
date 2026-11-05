import { sql, type Kysely } from "kysely";

import type { MossDatabase } from "@moss/db";

/** One already-sanitized record, ready for the table. Labels come from the shared allow-lists. */
export interface DiagnosticLogRow {
  readonly occurredAt: string;
  readonly process: "api" | "worker";
  readonly level: number;
  readonly component: string;
  readonly connectionKind: string | null;
  readonly eventCode: string | null;
  readonly ownerUserId: string | null;
  readonly message: string;
  readonly context: Record<string, unknown>;
  readonly truncated: boolean;
}

export interface DiagnosticLogSinkStats {
  queued: number;
  written: number;
  dropped: number;
  failed: number;
}

export interface DiagnosticLogSink {
  /** Synchronous. Never throws and never waits on the database. */
  enqueue(record: DiagnosticLogRow): void;
  flush(): Promise<void>;
  /** Flushes once (at most CLOSE_WAIT_MS), then ignores later records. */
  close(): Promise<void>;
  stats(): DiagnosticLogSinkStats;
}

export const LOG_SINK_LIMITS = {
  maxQueued: 500,
  maxQueuedBytes: 512 * 1024,
  maxPerMinute: 200,
  maxRecordBytes: 4096,
  batchSize: 100,
  statementTimeoutMs: 3000,
  flushDeadlineMs: 5000,
  closeWaitMs: 2000,
  flushDelayMs: 250,
  missingTablePauseMs: 30_000,
  stderrIntervalMs: 60_000
} as const;

const UNDEFINED_TABLE = "42P01";
const FOREIGN_KEY_VIOLATION = "23503";

function sqlState(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Size of the whole record as serialized, measured once per record. */
function rowBytes(row: DiagnosticLogRow): number {
  return Buffer.byteLength(JSON.stringify(row));
}

interface Queued {
  readonly row: DiagnosticLogRow;
  readonly bytes: number;
}

export interface CreateDiagnosticLogSinkOptions {
  /** Worker-role handle. The role may insert into the table and do nothing else. */
  db: Kysely<MossDatabase>;
  process: "api" | "worker";
  now?: () => number;
  /** Receives at most one line a minute. Must not feed the logger this sink serves. */
  stderr?: (line: string) => void;
}

export function createDiagnosticLogSink(opts: CreateDiagnosticLogSinkOptions): DiagnosticLogSink {
  const now = opts.now ?? (() => Date.now());
  const stderr =
    opts.stderr ??
    ((line: string) => {
      process.stderr.write(line);
    });
  let queue: Queued[] = [];
  let queuedBytes = 0;
  let flushing: Promise<void> | null = null;
  /** The database write still outstanding, even after its deadline passed. */
  let inFlight: Promise<void> | null = null;
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let pausedUntil = 0;
  let written = 0;
  let dropped = 0;
  let failed = 0;
  let windowStart = now();
  let windowCount = 0;
  let droppedSinceSummary = 0;
  let lastSummaryAt = now();
  let lastStderrAt = 0;

  function report(reason: string): void {
    try {
      const at = now();
      if (lastStderrAt !== 0 && at - lastStderrAt < LOG_SINK_LIMITS.stderrIntervalMs) return;
      lastStderrAt = at;
      stderr(`${JSON.stringify({ level: "warn", process: opts.process, msg: reason })}\n`);
    } catch {
      // The reporter must never take the process down.
    }
  }

  function drop(count = 1): void {
    dropped += count;
    droppedSinceSummary += count;
    scheduleSummary();
  }

  /** Emits the pending drop count once a minute has passed, even if no record follows. */
  function scheduleSummary(): void {
    if (summaryTimer !== null || closed) return;
    const wait = Math.max(0, lastSummaryAt + 60_000 - now()) + 10;
    summaryTimer = setTimeout(() => {
      summaryTimer = null;
      try {
        if (summarize(now(), false) && !closed) schedule();
      } catch {
        // A summary fault must not escape a timer.
      }
    }, wait);
    summaryTimer.unref?.();
  }

  function summarize(at: number, force: boolean): boolean {
    if (droppedSinceSummary === 0) return false;
    if (!force && at - lastSummaryAt < 60_000) return false;
    const count = droppedSinceSummary;
    droppedSinceSummary = 0;
    lastSummaryAt = at;
    push(summaryRow(at, count));
    return true;
  }

  function schedule(): void {
    if (timer !== null || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, LOG_SINK_LIMITS.flushDelayMs);
    timer.unref?.();
  }

  function push(row: DiagnosticLogRow): void {
    const bytes = rowBytes(row);
    queue.push({ row, bytes });
    queuedBytes += bytes;
    // Oldest records go first when either cap is hit.
    while (
      queue.length > LOG_SINK_LIMITS.maxQueued ||
      queuedBytes > LOG_SINK_LIMITS.maxQueuedBytes
    ) {
      const oldest = queue.shift();
      if (!oldest) break;
      queuedBytes -= oldest.bytes;
      dropped += 1;
      droppedSinceSummary += 1;
    }
  }

  function summaryRow(at: number, count: number): DiagnosticLogRow {
    return {
      occurredAt: new Date(at).toISOString(),
      process: opts.process,
      level: 40,
      component: "log",
      connectionKind: null,
      eventCode: "log.dropped",
      ownerUserId: null,
      message: `dropped ${count} log records`,
      context: { count },
      truncated: false
    };
  }

  function enqueue(record: DiagnosticLogRow): void {
    try {
      if (closed) return;
      const at = now();
      if (at - windowStart >= 60_000) {
        windowStart = at;
        windowCount = 0;
      }
      summarize(at, false);
      if (rowBytes(record) > LOG_SINK_LIMITS.maxRecordBytes) {
        drop();
        return;
      }
      if (windowCount >= LOG_SINK_LIMITS.maxPerMinute) {
        drop();
        return;
      }
      windowCount += 1;
      push(record);
      schedule();
    } catch {
      drop();
    }
  }

  async function insert(batch: readonly DiagnosticLogRow[], keepOwners: boolean): Promise<void> {
    const values = sql.join(
      batch.map(
        (row) => sql`(
          ${row.occurredAt}::timestamptz, ${row.process}, ${row.level}::smallint,
          ${row.component}, ${row.connectionKind}, ${row.eventCode},
          ${keepOwners ? row.ownerUserId : null}::uuid, ${row.message},
          ${JSON.stringify(row.context)}::jsonb, ${row.truncated}
        )`
      )
    );
    await opts.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${String(LOG_SINK_LIMITS.statementTimeoutMs)}, true)`.execute(
        trx
      );
      await sql`
        INSERT INTO app.diagnostic_log_records
          (occurred_at, process, level, component, connection_kind, event_code,
           owner_user_id, message, context, truncated)
        VALUES ${values}
      `.execute(trx);
    });
  }

  async function writeBatch(batch: readonly DiagnosticLogRow[]): Promise<void> {
    try {
      await insert(batch, true);
    } catch (error) {
      if (sqlState(error) !== FOREIGN_KEY_VIOLATION) throw error;
      // A stale owner id must not lose the batch. Retry without owners.
      await insert(batch, false);
    }
  }

  async function runFlush(): Promise<void> {
    // A write that outlived its deadline may still hold a connection. Wait for it to end.
    if (inFlight) return;
    if (now() < pausedUntil) return;
    summarize(now(), false);
    const deadline = Date.now() + LOG_SINK_LIMITS.flushDeadlineMs;
    while (queue.length > 0) {
      const left = deadline - Date.now();
      if (left <= 0) {
        failed += 1;
        report("log storage slow, flush cut short");
        return;
      }
      const batch = queue.splice(0, LOG_SINK_LIMITS.batchSize);
      for (const item of batch) queuedBytes -= item.bytes;
      const rows = batch.map((item) => item.row);
      const write = writeBatch(rows);
      inFlight = write.then(
        () => {},
        () => {}
      );
      void inFlight.then(() => {
        inFlight = null;
        if (queue.length > 0) schedule();
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          write,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("log flush deadline")), left);
            timeout.unref?.();
          })
        ]);
        written += rows.length;
      } catch (error) {
        failed += 1;
        drop(rows.length);
        if (sqlState(error) === UNDEFINED_TABLE) {
          pausedUntil = now() + LOG_SINK_LIMITS.missingTablePauseMs;
          report("log table missing, pausing log storage");
          return;
        }
        report("log storage failed, batch dropped");
        return;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
  }

  function flush(): Promise<void> {
    // One flush at a time. Records arriving meanwhile wait in the queue.
    if (flushing) return flushing;
    flushing = runFlush()
      .catch(() => {
        failed += 1;
      })
      .finally(() => {
        flushing = null;
        if (queue.length > 0) schedule();
      });
    return flushing;
  }

  async function close(): Promise<void> {
    if (closed) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (summaryTimer !== null) {
      clearTimeout(summaryTimer);
      summaryTimer = null;
    }
    // Drops still pending at shutdown get their summary now.
    try {
      summarize(now(), true);
    } catch {
      // Closing must not throw.
    }
    let wait: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          if (flushing) await flushing;
          await flush();
        })(),
        new Promise<void>((resolve) => {
          wait = setTimeout(resolve, LOG_SINK_LIMITS.closeWaitMs);
          wait.unref?.();
        })
      ]);
    } finally {
      if (wait !== undefined) clearTimeout(wait);
      closed = true;
      queue = [];
      queuedBytes = 0;
    }
  }

  return {
    enqueue,
    flush,
    close,
    stats: () => ({ queued: queue.length, written, dropped, failed })
  };
}
