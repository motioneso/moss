import {
  LOG_COMPONENTS,
  LOG_CONNECTION_KINDS,
  LOG_EVENT_CODES,
  LOG_LIMITS,
  createSanitizedLogDestination,
  truncateUtf8,
  type LogWriteTarget
} from "@moss/shared";

import type { DiagnosticLogRow, DiagnosticLogSink } from "./diagnostic-log-sink.js";

/** Records below warn stay on stdout. */
const MIN_STORED_LEVEL = 40;
const STREAM_BACKLOG_LIMIT = 256 * 1024;

/** Fields that become columns, or that pino and the sanitizer add to every line. */
const NON_CONTEXT_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "process",
  "actorUserId",
  "msg",
  "module",
  "component",
  "connectionKind",
  "eventCode",
  "truncated"
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exact match against a fixed list, else null. Free text never survives. */
function fromList(list: readonly string[], value: unknown): string | null {
  return typeof value === "string" && list.includes(value) ? value : null;
}

/** A context that fits the column limit once JSON-escaped, shrinking the kept text until it does. */
function cutContext(serialized: string): Record<string, unknown> {
  for (const budget of [1800, 1000, 400, 100]) {
    const cut = { _cut: truncateUtf8(serialized, budget).text };
    if (Buffer.byteLength(JSON.stringify(cut)) <= LOG_LIMITS.contextBytes) return cut;
  }
  return {};
}

/**
 * Turn one line that has already been sanitized into a table row, or null when it is below
 * warn or cannot be read. Only the sanitized text is parsed, so the stored copy is never raw.
 */
export function rowFromSanitizedLine(
  line: string,
  processName: "api" | "worker",
  now: () => number = Date.now
): DiagnosticLogRow | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const level = source.level;
  if (typeof level !== "number" || level < MIN_STORED_LEVEL) return null;

  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!NON_CONTEXT_KEYS.has(key)) context[key] = value;
  }
  let truncated = source.truncated === true;
  let storedContext = context;
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized) > LOG_LIMITS.contextBytes) {
    storedContext = cutContext(serialized);
    truncated = true;
  }
  const message = truncateUtf8(
    typeof source.msg === "string" ? source.msg : "",
    LOG_LIMITS.messageBytes
  );
  const time = typeof source.time === "number" ? source.time : now();
  const ownerUserId =
    typeof source.actorUserId === "string" && UUID.test(source.actorUserId)
      ? source.actorUserId.toLowerCase()
      : null;
  return {
    occurredAt: new Date(Number.isFinite(time) ? time : now()).toISOString(),
    process: processName,
    level: Math.min(60, Math.round(level)),
    component:
      fromList(LOG_COMPONENTS, source.component) ??
      fromList(LOG_COMPONENTS, source.module) ??
      (processName === "api" ? "api" : "worker"),
    connectionKind: fromList(LOG_CONNECTION_KINDS, source.connectionKind),
    eventCode: fromList(LOG_EVENT_CODES, source.eventCode),
    ownerUserId,
    message: message.text,
    context: storedContext,
    truncated: truncated || message.cut
  };
}

export interface DiagnosticLogDestinationOptions {
  process: "api" | "worker";
  /** The raw output stream. Defaults to stdout. */
  target?: LogWriteTarget;
  /** Null when logging to the table is off. Stdout is still sanitized. */
  sink: DiagnosticLogSink | null;
}

/**
 * Pino destination. Each line is sanitized first, written to the stream, and then (warn and
 * above) the same sanitized text is queued for the table. A sink fault never reaches the caller.
 */
export function createDiagnosticLogDestination(
  opts: DiagnosticLogDestinationOptions
): LogWriteTarget {
  const target = opts.target ?? process.stdout;
  const sanitizedStream = createSanitizedLogDestination({
    write(chunk: string): unknown {
      // A stalled stream drops its copy once 256 KB is buffered. The table path continues.
      const pending = (target as { writableLength?: number }).writableLength ?? 0;
      const result = pending > STREAM_BACKLOG_LIMIT ? true : target.write(chunk);
      if (opts.sink) {
        try {
          const row = rowFromSanitizedLine(chunk, opts.process);
          if (row) opts.sink.enqueue(row);
        } catch {
          // A broken sink must never break logging.
        }
      }
      return result;
    }
  });
  return sanitizedStream;
}

/** Child logger bound to the owner of this request or job. A value that is not a uuid binds nothing. */
export function withLogOwner<T extends { child(bindings: Record<string, unknown>): T }>(
  logger: T,
  actorUserId: string | null | undefined
): T {
  if (typeof actorUserId !== "string" || !UUID.test(actorUserId)) return logger;
  return logger.child({ actorUserId });
}
