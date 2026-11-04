/**
 * Log sanitizer shared by the API and worker processes. Pure functions, no I/O except the
 * explicit stream wrapper at the bottom. Every log line and error line that leaves a process
 * passes through here first. Any failure drops the record. It never falls back to the raw input.
 */

export const LOG_REDACTED = "[redacted]";

/** Hard bounds on how much work and output one record can cost. */
export const LOG_LIMITS = {
  messageBytes: 2048,
  contextBytes: 2048,
  maxDepth: 6,
  maxKeys: 200,
  maxItems: 200,
  maxVisitedTextBytes: 64 * 1024,
  stackBytes: 1024
} as const;

/** Counts records dropped because sanitizing failed. */
export const LOG_DROP_COUNTER = { count: 0 };

const LEGACY_PATTERNS: readonly RegExp[] = [
  // `JARVIS_MCP_TOKEN=<value>` env-var prefix on the launch line (Codex path).
  /JARVIS_MCP_TOKEN=\S+/gi,
  // `Authorization: Bearer <value>` / `Bearer <value>` header form.
  /Bearer\s+\S+/gi,
  // Bare session-token tokens (`jst_...`) anywhere they appear.
  /jst_[A-Za-z0-9_-]+/g,
  // Common provider/API key prefixes.
  /\bsk-(?:(?:ant|proj|live|test)[-_])?[A-Za-z0-9][A-Za-z0-9_-]+\b/gi,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi,
  /\b(?:ghp|github_pat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/gi,
  // Secret-bearing query parameters, preserving the URL key and separators.
  /([?&](?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)=)[^&#\s]+/gi,
  // Secret-bearing environment assignments.
  /\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH(?:ORIZATION)?|CLIENT[_-]?SECRET|PASSWORD|SECRET|TOKEN|KEY)=[^&\s}]+/gi,
  // Secret-bearing JSON/object fields. Keep the field name and JSON quoting intact.
  /(["']?(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|token|key)["']?\s*:\s*)(["']?)([^"'\s,}]+)\2/gi
];

/** `scheme://user:password@host`. Keeps scheme, user and host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#"']*:)[^\s/?#"']*@/gi;

/** Whole header value up to the end of the line or the closing JSON quote. */
const HEADER_NAME = String.raw`(?:Authorization|Set-Cookie|Cookie)`;
/** Value in quotes (JSON field): up to the closing quote. */
const QUOTED_HEADER = new RegExp(
  String.raw`(\b${HEADER_NAME}["']?\s*[:=]\s*")(?:\\.|[^"\\\r\n])*`,
  "gi"
);
/** Bare value (HTTP header text): the whole rest of the line, quotes included (Digest). */
const BARE_HEADER = new RegExp(String.raw`(\b${HEADER_NAME}["']?\s*[:=]\s*)(?!["'])[^\r\n]*`, "gi");

/**
 * Replace secret-bearing substrings with a fixed marker. Safe on undefined and empty input.
 * Covers the older shapes plus URL passwords, cookies and every Authorization scheme.
 */
export function redactSecrets(text: string | undefined): string {
  if (!text) return "";
  let out = text;
  out = out.replace(QUOTED_HEADER, `$1${LOG_REDACTED}`);
  out = out.replace(BARE_HEADER, `$1${LOG_REDACTED}`);
  out = out.replace(URL_CREDENTIALS, `$1${LOG_REDACTED}@`);
  out = out.replace(LEGACY_PATTERNS[0]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[1]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[2]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[3]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[4]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[5]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[6]!, `$1${LOG_REDACTED}`);
  out = out.replace(LEGACY_PATTERNS[7]!, LOG_REDACTED);
  out = out.replace(LEGACY_PATTERNS[8]!, `$1$2${LOG_REDACTED}$2`);
  return out;
}

/** Mask secret shapes in one string. */
export function sanitizeLogText(text: string): string {
  return redactSecrets(text);
}

const SECRET_KEY =
  /pass(?:word|wd)|token|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key/i;

/** Cut to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

interface Budget {
  text: number;
  cut: boolean;
}

function sanitizeString(value: string, budget: Budget): string {
  if (budget.text <= 0) {
    budget.cut = true;
    return "[truncated]";
  }
  let input = value;
  if (input.length > budget.text) {
    input = input.slice(0, budget.text);
    budget.cut = true;
  }
  budget.text -= input.length;
  return redactSecrets(input);
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, budget: Budget): unknown {
  if (typeof value === "string") return sanitizeString(value, budget);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return "[unserializable]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth >= LOG_LIMITS.maxDepth) {
    budget.cut = true;
    return "[truncated]";
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, LOG_LIMITS.maxItems).map((v) => walk(v, depth + 1, seen, budget));
      if (obj.length > LOG_LIMITS.maxItems) {
        budget.cut = true;
        items.push(`[${obj.length - LOG_LIMITS.maxItems} more]`);
      }
      return items;
    }
    const out: Record<string, unknown> = {};
    if (obj instanceof Error) {
      out.name = sanitizeString(obj.name, budget);
      out.message = sanitizeString(obj.message, budget);
      if (typeof obj.stack === "string") {
        const stack = truncateUtf8(sanitizeString(obj.stack, budget), LOG_LIMITS.stackBytes);
        out.stack = stack.text;
      }
      const withExtras = obj as Error & { cause?: unknown; errors?: unknown };
      if (withExtras.cause !== undefined)
        out.cause = walk(withExtras.cause, depth + 1, seen, budget);
      if (withExtras.errors !== undefined)
        out.errors = walk(withExtras.errors, depth + 1, seen, budget);
    }
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, LOG_LIMITS.maxKeys)) {
      if (key in out) continue;
      const child = (obj as Record<string, unknown>)[key];
      out[key] = SECRET_KEY.test(key) ? LOG_REDACTED : walk(child, depth + 1, seen, budget);
    }
    if (keys.length > LOG_LIMITS.maxKeys) {
      budget.cut = true;
      out._more = keys.length - LOG_LIMITS.maxKeys;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function newBudget(): Budget {
  return { text: LOG_LIMITS.maxVisitedTextBytes, cut: false };
}

/**
 * Deep copy with secrets masked. Walks Errors, cause chains, `errors` arrays and plain objects
 * to a fixed depth with a cycle guard. Keys that name secrets are masked by key. Throws only if
 * a getter throws, so callers that need a drop-on-failure guarantee use sanitizeLogRecord.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet(), newBudget());
}

export interface SanitizedLogRecord {
  readonly message: string;
  readonly context: Record<string, unknown>;
  readonly truncated: boolean;
}

/**
 * Sanitize one message plus its context. Returns null (and counts a drop) if anything throws.
 * The raw input is never returned.
 */
export function sanitizeLogRecord(message: unknown, context?: unknown): SanitizedLogRecord | null {
  try {
    const budget = newBudget();
    const seen = new WeakSet<object>();
    const rawMessage =
      typeof message === "string" ? message : message === undefined ? "" : String(message);
    const maskedMessage = sanitizeString(rawMessage, budget);
    const cutMessage = truncateUtf8(maskedMessage, LOG_LIMITS.messageBytes);

    let masked = context === undefined ? {} : walk(context, 0, seen, budget);
    if (masked === null || typeof masked !== "object" || Array.isArray(masked)) {
      masked = { value: masked };
    }
    let ctx = masked as Record<string, unknown>;
    let truncated = cutMessage.cut || budget.cut;
    const serialized = JSON.stringify(ctx);
    if (Buffer.byteLength(serialized) > LOG_LIMITS.contextBytes) {
      ctx = { _cut: truncateUtf8(serialized, LOG_LIMITS.contextBytes).text };
      truncated = true;
    }
    return { message: cutMessage.text, context: ctx, truncated };
  } catch {
    LOG_DROP_COUNTER.count += 1;
    return null;
  }
}

const RESERVED_LINE_KEYS = new Set(["level", "time", "pid", "hostname", "process", "actorUserId"]);

/**
 * Sanitize one stdout line (a pino JSON line or plain text). Keeps a trailing newline.
 * Returns null when the line cannot be sanitized, and the caller must not write it.
 */
export function sanitizeLogLine(line: string): string | null {
  try {
    if (typeof line !== "string") throw new TypeError("log line is not a string");
    const newline = line.endsWith("\n") ? "\n" : "";
    const body = newline ? line.slice(0, -1) : line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const text = truncateUtf8(
        sanitizeString(body, newBudget()),
        LOG_LIMITS.messageBytes + LOG_LIMITS.contextBytes
      );
      return `${text.text}${newline}`;
    }
    const source = parsed as Record<string, unknown>;
    const reserved: Record<string, unknown> = {};
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "msg") continue;
      if (RESERVED_LINE_KEYS.has(key)) reserved[key] = value;
      else rest[key] = value;
    }
    const record = sanitizeLogRecord(source.msg, rest);
    if (!record) return null;
    const safeReserved = sanitizeLogValue(reserved) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      ...safeReserved,
      ...(source.msg === undefined ? {} : { msg: record.message }),
      ...record.context,
      ...(record.truncated ? { truncated: true } : {})
    };
    return `${JSON.stringify(out)}${newline}`;
  } catch {
    LOG_DROP_COUNTER.count += 1;
    return null;
  }
}

export interface LogWriteTarget {
  write(chunk: string): unknown;
}

/**
 * Wrap a stream so every line is sanitized before it is written. A line that fails sanitizing
 * is dropped. Works as a pino destination. `target` defaults to process.stdout.
 */
export function createSanitizedLogDestination(
  target: LogWriteTarget = process.stdout
): LogWriteTarget {
  return {
    write(chunk: string): boolean {
      const text = Buffer.isBuffer(chunk) ? (chunk as Buffer).toString("utf8") : chunk;
      const clean = sanitizeLogLine(text);
      if (clean === null) return true;
      target.write(clean);
      return true;
    }
  };
}

/**
 * Write one sanitized error line for crash, startup and shutdown paths. Only the message text of
 * an Error (or a string) is written, never the error object. `write` defaults to stderr.
 */
export function writeSanitizedFatal(
  label: string,
  err: unknown,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
  msg = "Process crash - exiting"
): void {
  try {
    const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown";
    const name = err instanceof Error ? err.name : undefined;
    const record = sanitizeLogRecord(raw, {});
    if (!record) return;
    write(
      `${JSON.stringify({
        level: "fatal",
        label: sanitizeLogText(label),
        ...(name ? { name: sanitizeLogText(name) } : {}),
        err: record.message,
        msg
      })}\n`
    );
  } catch {
    LOG_DROP_COUNTER.count += 1;
  }
}
