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

/**
 * The one list of secret-bearing names, written flat. A name matches however it is spelled,
 * because detection runs on text with case, spaces, dots, underscores, hyphens, backslashes and
 * quotes removed ("pass phrase", "pass_phrase", "API KEY", "\\"password\\"" all contain
 * "passphrase" or "password"). Object keys and text use the same matcher.
 */
const SECRET_MARKERS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "signingkey",
  "encryptionkey",
  "authkey",
  "authorization",
  "cookie",
  "credential",
  "sessionid",
  "bearer"
] as const;

/** Characters ignored while detecting a name. */
const IGNORED_FOR_DETECTION = /[\s._\-\\"'`]/;

/** Words that contain a marker but are ordinary ("secretary"). Checked right after the marker. */
const BENIGN_AFTER: Readonly<Record<string, readonly string[]>> = {
  secret: ["ary", "ariat", "ive", "ively", "ion", "ions"]
};

interface MarkerHit {
  /** Index in the original text where the marker starts. */
  readonly start: number;
  /** Index in the original text just past the marker's last character. */
  readonly end: number;
}

/** The first secret marker in `text`, or null. Runs in time linear in the text. */
function findSecretMarker(text: string): MarkerHit | null {
  let flat = "";
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (IGNORED_FOR_DETECTION.test(ch)) continue;
    flat += ch.toLowerCase();
    positions.push(i);
  }
  let best: { at: number; length: number } | null = null;
  for (const marker of SECRET_MARKERS) {
    let from = 0;
    for (;;) {
      const at = flat.indexOf(marker, from);
      if (at < 0) break;
      from = at + 1;
      const benign = BENIGN_AFTER[marker]?.some((suffix) =>
        flat.startsWith(suffix, at + marker.length)
      );
      if (benign) continue;
      if (best === null || at < best.at) best = { at, length: marker.length };
      break;
    }
  }
  if (best === null) return null;
  return { start: positions[best.at]!, end: positions[best.at + best.length - 1]! + 1 };
}

/** True when a field name holds a secret, however it is spelled. */
export function isSecretName(name: string): boolean {
  return findSecretMarker(name) !== null;
}

/** A separator right after a name (`": "`, `=`, `=\"`) is kept so the field name stays readable. */
const AFTER_NAME = /^[\w.-]{0,24}[\\"'`]*\s*[:=]\s*[\\"'`]*/;

/**
 * Fail closed on text. From the first secret marker to the end of the string, everything is
 * replaced. Over-hiding is accepted. The text is never parsed, so no quoting, escaping, nesting
 * or newline can hide the end of a value.
 */
function maskFromSecretMarker(text: string): string {
  const hit = findSecretMarker(text);
  if (hit === null) return text;
  const rest = text.slice(hit.end);
  if (rest.trim() === "") return text;
  const separator = AFTER_NAME.exec(rest.slice(0, 80));
  const keep = hit.end + (separator ? separator[0].length : 0);
  const joiner = separator ? "" : " ";
  return `${text.slice(0, keep)}${joiner}${LOG_REDACTED}`;
}

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

const SCHEME_CHAR = /[a-z0-9+.-]/i;

/**
 * End of a URL authority. Whitespace or a path, query or fragment delimiter. Quote characters
 * can be part of a password, so they do not end it. The cost is that a JSON field after a URL
 * can be masked along with it, which hides more than needed and never less.
 */
function isAuthorityEnd(text: string, index: number): boolean {
  const ch = text[index]!;
  return ch === "/" || ch === "?" || ch === "#" || /\s/.test(ch);
}

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
    while (end < text.length && !isAuthorityEnd(text, end)) end++;
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
const DANGLING_AUTHORITY = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#]*$/i;

function dropDanglingAuthority(text: string): string {
  const match = DANGLING_AUTHORITY.exec(text);
  if (!match) return text;
  return `${text.slice(0, match.index)}[truncated]`;
}

/** Input longer than this is never read. Only its length is reported. */
const HARD_INPUT_CHARS = 1_000_000;

/**
 * Mask, then cut. Credentials in a URL are masked across the whole input with the linear scan
 * before any cut, so a long password never leaves its first characters behind. Input past the
 * hard ceiling is dropped without being read.
 */
function maskAndCut(input: string, maxChars: number): { text: string; cut: boolean } {
  if (input.length > HARD_INPUT_CHARS) {
    return { text: `[truncated ${input.length} chars]`, cut: true };
  }
  if (input.length <= maxChars) return { text: redactSecrets(input), cut: false };
  const urlMasked = maskUrlCredentials(input);
  const masked = redactSecrets(urlMasked.slice(0, maxChars));
  return { text: dropDanglingAuthority(masked), cut: true };
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
  out = maskFromSecretMarker(maskUrlCredentials(out));
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
  const result = maskAndCut(value, room);
  if (result.cut) budget.cut = true;
  budget.text -= Math.min(value.length, room);
  return result.text;
}

/** A key can carry a secret too, so it is masked and bounded like a value. */
function sanitizeKey(key: string): string {
  return maskAndCut(key, 256).text;
}

/** Cut masked text to a byte limit and drop an authority the cut may have split. */
function cutMasked(text: string, maxBytes: number): { text: string; cut: boolean } {
  const result = truncateUtf8(text, maxBytes);
  return result.cut ? { text: dropDanglingAuthority(result.text), cut: true } : result;
}

/** Byte size of a binary value that needs no key listing, or -1 when the value is not one. */
function binarySize(value: object): number {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return value.byteLength;
  }
  // The shape JSON.stringify gives a Buffer.
  const asBuffer = value as { type?: unknown; data?: unknown };
  if (asBuffer.type === "Buffer" && Array.isArray(asBuffer.data)) return asBuffer.data.length;
  return -1;
}

/** Typed arrays after a JSON round trip are objects keyed "0", "1", "2" with byte values. */
function looksLikeByteMap(value: object, keys: string[]): boolean {
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
  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? "Invalid Date" : obj.toISOString();
  }
  // One budget for the whole record, so a shared sub-object cannot be expanded again and again.
  // It is checked before any key is listed.
  if (budget.nodes <= 0) {
    budget.cut = true;
    return "[truncated]";
  }
  budget.nodes -= 1;
  const size = binarySize(obj);
  if (size >= 0) return `[binary ${size} bytes]`;
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
    // One key listing per object serves both the binary check and the copy.
    const keys = Object.keys(obj);
    if (looksLikeByteMap(obj, keys)) return `[binary ${keys.length} bytes]`;
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
    copyKeys(obj, keys, out, depth, seen, budget, undefined);
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Copy up to maxKeys keys into `out`, masking secret keys, key text and values. */
function copyKeys(
  obj: object,
  keys: string[],
  out: Record<string, unknown>,
  depth: number,
  seen: WeakSet<object>,
  budget: Budget,
  keep: ReadonlySet<string> | undefined
): void {
  let count = 0;
  for (const key of keys) {
    if (count >= LOG_LIMITS.maxKeys) {
      budget.cut = true;
      out._more = true;
      break;
    }
    count += 1;
    const safeKey = sanitizeKey(key);
    if (safeKey in out) continue;
    const child = (obj as Record<string, unknown>)[key];
    if (isSecretName(key)) out[safeKey] = LOG_REDACTED;
    else if (keep?.has(key)) out[safeKey] = child;
    else out[safeKey] = walk(child, depth + 1, seen, budget);
  }
}

/**
 * Sanitize the object a logger call merges into a record. Values under `keep` are left for the
 * logger's own serializers (request, response, error), and the final line is masked afterwards.
 * Everything else is bounded and masked here, before pino serializes it.
 */
export function sanitizeLogContext(
  obj: Record<string, unknown>,
  keep: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  copyKeys(obj, Object.keys(obj), out, -1, new WeakSet(), newBudget(), keep);
  return out;
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

/** Keys whose values pino's own serializers shape (Fastify request, response and error). */
const DEFAULT_SERIALIZED_KEYS = ["req", "res", "err"];

/**
 * Pino formatters that bound and mask the merge object before pino serializes it. Values under
 * serializer keys are left alone for their serializers, and a caller's own log formatter runs
 * first. A record that cannot be walked is replaced and counted.
 */
export function createSanitizingFormatters(
  options: {
    log?: (object: Record<string, unknown>) => Record<string, unknown>;
    serializerKeys?: Iterable<string>;
  } = {}
): { log(object: Record<string, unknown>): Record<string, unknown> } {
  const keep = new Set([...DEFAULT_SERIALIZED_KEYS, ...(options.serializerKeys ?? [])]);
  return {
    log(object) {
      try {
        const shaped = options.log ? options.log(object) : object;
        return sanitizeLogContext(shaped, keep);
      } catch {
        LOG_DROP_COUNTER.count += 1;
        return { _dropped: true };
      }
    }
  };
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
        msg: sanitizeLogText(msg)
      })}\n`
    );
  } catch {
    LOG_DROP_COUNTER.count += 1;
  }
}
