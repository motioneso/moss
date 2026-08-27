const MAX_METADATA_BYTES = 2048;
const MAX_STRING_LENGTH = 200;
// `reason` has its own column on the signals table and belongs only to its owner. Blocking it here
// stops a verifier from also smuggling a copy into the generic metadata object, where it would
// reach anywhere metadata travels (#2016).
const UNSAFE_METADATA_KEY =
  /(?:body|excerpt|external_?id|prompt|raw|reason|secret|source_?ids?|summary|token)/i;

export function sanitizeFeedbackMetadata(
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  const value = sanitizeObject(input ?? {});
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_METADATA_BYTES) return value;

  const trimmed: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    trimmed[key.slice(0, MAX_STRING_LENGTH)] = entry;
    serialized = JSON.stringify(trimmed);
    if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
      delete trimmed[key.slice(0, MAX_STRING_LENGTH)];
      break;
    }
  }
  return trimmed;
}

function sanitizeObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const sanitizedKey = key.slice(0, MAX_STRING_LENGTH);
    if (UNSAFE_METADATA_KEY.test(sanitizedKey)) continue;
    output[sanitizedKey] = sanitizeValue(value);
  }
  return output;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
  if (typeof value === "object") return sanitizeObject(value as Record<string, unknown>);
  return String(value).slice(0, MAX_STRING_LENGTH);
}
