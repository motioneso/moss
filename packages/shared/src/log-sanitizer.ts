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
  maxStringChars: 16 * 1024,
  maxNodes: 2000,
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

const AUTHORITY_END = /[\s/?#"']/;
const SCHEME_CHAR = /[a-z0-9+.-]/i;

/**
 * Mask `scheme://user:password@host` in one linear pass (a regex here backtracks quadratically
 * on hostile input). Keeps scheme, user and host. The password runs to the last `@` of the
 * authority, so a password that holds `@` is covered.
 */
function maskUrlCredentials(text: string): string {
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const marker = text.indexOf("://", from);
    if (marker < 0) break;
    from = marker + 3;
    // The scheme must start with a letter and run back from the marker.
    let start = marker;
    while (start > 0 && marker - start < 32 && SCHEME_CHAR.test(text[start - 1]!)) start--;
    while (start < marker && !/[a-z]/i.test(text[start]!)) start++;
    if (start === marker) continue;
    let end = from;
    while (end < text.length && !AUTHORITY_END.test(text[end]!)) end++;
    const authority = text.slice(from, end);
    const firstAt = authority.indexOf("@");
    const colon = authority.indexOf(":");
    if (firstAt >= 0 && colon >= 0 && colon < firstAt) {
      const lastAt = authority.lastIndexOf("@");
      out += `${text.slice(copied, from + colon + 1)}${LOG_REDACTED}`;
      copied = from + lastAt;
    }
    from = end;
  }
  return out + text.slice(copied);
}

/** An authority that ends the text without a terminator may hold the start of a password. */
const DANGLING_AUTHORITY = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#"']*$/i;

function dropDanglingAuthority(text: string): string {
  const tail = text.slice(-2100);
  const match = DANGLING_AUTHORITY.exec(tail);
  if (!match) return text;
  return `${text.slice(0, text.length - tail.length + match.index)}[truncated]`;
}

/** Whole header value up to the end of the line or the closing JSON quote. */
const HEADER_NAME = String.raw`(?:Authorization|Set-Cookie|Cookie)`;
/** Value in single or double quotes: up to the matching closing quote. */
const QUOTED_HEADER = new RegExp(
  String.raw`(\b${HEADER_NAME}["']?\s*[:=]\s*(["']))(?:\\.|(?!\2)[^\\\r\n])*`,
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
  out = maskUrlCredentials(out);
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

/** Mask secret shapes in one string. Input past the string cap is masked and then cut. */
export function sanitizeLogText(text: string): string {
  return sanitizeString(String(text), newBudget());
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
  nodes: number;
  cut: boolean;
}

function sanitizeString(value: string, budget: Budget): string {
  if (budget.text <= 0) {
    budget.cut = true;
    return "[truncated]";
  }
  const room = Math.min(budget.text, LOG_LIMITS.maxStringChars);
  let input = value;
  let cut = false;
  if (input.length > room) {
    input = input.slice(0, room);
    cut = true;
    budget.cut = true;
  }
  budget.text -= input.length;
  const masked = redactSecrets(input);
  // Masking runs before any cut, and a cut that lands inside an authority drops its start.
  return cut ? dropDanglingAuthority(masked) : masked;
}

/** Cut masked text to a byte limit and drop an authority the cut may have split. */
function cutMasked(text: string, maxBytes: number): { text: string; cut: boolean } {
  const result = truncateUtf8(text, maxBytes);
  return result.cut ? { text: dropDanglingAuthority(result.text), cut: true } : result;
}

function isBinary(value: object): boolean {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return true;
  // The shapes JSON.stringify gives a Buffer or a typed array before the line is parsed back.
  const asBuffer = value as { type?: unknown; data?: unknown };
  if (asBuffer.type === "Buffer" && Array.isArray(asBuffer.data)) return true;
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 4) return false;
  for (let i = 0; i < Math.min(keys.length, 16); i++) {
    const v = (value as Record<string, unknown>)[keys[i]!];
    if (keys[i] !== String(i) || typeof v !== "number" || v < 0 || v > 255 || !Number.isInteger(v))
      return false;
  }
  return true;
}

function walk(value: unknown, depth: number, seen: WeakSet<object>, budget: Budget): unknown {
  if (typeof value === "string") return sanitizeString(value, budget);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return "[unserializable]";
  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (isBinary(obj)) {
    const size = ArrayBuffer.isView(obj)
      ? obj.byteLength
      : obj instanceof ArrayBuffer
        ? obj.byteLength
        : Object.keys(obj).length;
    return `[binary ${size} bytes]`;
  }
  // One budget for the whole record, so a shared sub-object cannot be expanded again and again.
  if (budget.nodes <= 0) {
    budget.cut = true;
    return "[truncated]";
  }
  budget.nodes -= 1;
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
        const stack = cutMasked(sanitizeString(obj.stack, budget), LOG_LIMITS.stackBytes);
        out.stack = stack.text;
      }
      const withExtras = obj as Error & { cause?: unknown; errors?: unknown };
      if (withExtras.cause !== undefined)
        out.cause = walk(withExtras.cause, depth + 1, seen, budget);
      if (withExtras.errors !== undefined)
        out.errors = walk(withExtras.errors, depth + 1, seen, budget);
    }
    let count = 0;
    for (const key in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      if (count >= LOG_LIMITS.maxKeys) {
        budget.cut = true;
        out._more = true;
        break;
      }
      count += 1;
      if (key in out) continue;
      const child = (obj as Record<string, unknown>)[key];
      out[key] = SECRET_KEY.test(key) ? LOG_REDACTED : walk(child, depth + 1, seen, budget);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

function newBudget(): Budget {
  return { text: LOG_LIMITS.maxVisitedTextBytes, nodes: LOG_LIMITS.maxNodes, cut: false };
}

/**
 * Deep copy with secrets masked. Walks Errors, cause chains, `errors` arrays and plain objects
 * to a fixed depth with a cycle guard. Keys that name secrets are masked by key. Throws only if
 * a getter throws, so callers that need a drop-on-failure guarantee use sanitizeLogRecord.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return walk(value, 0, new WeakSet(), newBudget());
}

/**
 * Pino formatter for the merge object. It runs before pino serializes the record, so a huge or
 * heavily shared object is bounded first. A value that cannot be walked is replaced and counted.
 */
export const sanitizingLogFormatters = {
  log(object: Record<string, unknown>): Record<string, unknown> {
    try {
      const walked = sanitizeLogValue(object);
      return walked !== null && typeof walked === "object"
        ? (walked as Record<string, unknown>)
        : {};
    } catch {
      LOG_DROP_COUNTER.count += 1;
      return { _dropped: true };
    }
  }
};

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
    const cutMessage = cutMasked(maskedMessage, LOG_LIMITS.messageBytes);

    let masked = context === undefined ? {} : walk(context, 0, seen, budget);
    if (masked === null || typeof masked !== "object" || Array.isArray(masked)) {
      masked = { value: masked };
    }
    let ctx = masked as Record<string, unknown>;
    let truncated = cutMessage.cut || budget.cut;
    const serialized = JSON.stringify(ctx);
    if (Buffer.byteLength(serialized) > LOG_LIMITS.contextBytes) {
      ctx = { _cut: cutMasked(serialized, LOG_LIMITS.contextBytes).text };
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
    const record = sanitizeLogRecord(raw, {});
    if (!record) return;
    write(
      `${JSON.stringify({
        level: "fatal",
        label: sanitizeLogText(label),
        err: record.message,
        msg
      })}\n`
    );
  } catch {
    LOG_DROP_COUNTER.count += 1;
  }
}
