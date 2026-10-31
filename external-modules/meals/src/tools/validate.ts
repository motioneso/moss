// external-modules/meals/src/tools/validate.ts
//
// Tool-input readers, copied from Food's validate.ts because a module may not import another
// module. Every error names the key and the rule it broke, never the value.

export class InputError extends Error {
  readonly code: string;

  /**
   * One-arg form keeps the classic validation code ("invalid_input"); the
   * two-arg form is available for a handler-level condition a caller keys
   * remediation on (finance's precedent), unused by this file today.
   */
  constructor(codeOrMessage: string, message?: string) {
    super(message ?? codeOrMessage);
    this.name = "InputError";
    this.code = message === undefined ? "invalid_input" : codeOrMessage;
  }
}

/**
 * The host spreads actorUserId onto every external tool input as an
 * anti-spoof measure (FIN-04 / apps/api/src/external-module-tools.ts). It is
 * deliberate and it is not going away, so every strict validator in this
 * module strips it before checking for unknown keys.
 */
export function stripEnvelope(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputError("input must be an object");
  }
  const { actorUserId, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/** Throws on the first key in `input` that is not in `allowed` — never lists every extra key,
 * matching job-search/finance handlers' one-error-at-a-time discipline. */
export function requireNoUnknownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new InputError(`unknown key: ${key}`);
    }
  }
}

export function readString(
  input: Record<string, unknown>,
  key: string,
  opts: { required: true; maxBytes?: number }
): string;
export function readString(
  input: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean; maxBytes?: number }
): string | undefined;
export function readString(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxBytes?: number } = {}
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new InputError(`${key} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new InputError(`${key} must be a string`);
  }
  if (opts.maxBytes !== undefined && Buffer.byteLength(value, "utf8") > opts.maxBytes) {
    throw new InputError(`${key} exceeds ${opts.maxBytes} bytes of UTF-8`);
  }
  return value;
}

export function readBool(
  input: Record<string, unknown>,
  key: string,
  opts: { required: true }
): boolean;
export function readBool(
  input: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean }
): boolean | undefined;
export function readBool(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean } = {}
): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new InputError(`${key} is required`);
    }
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new InputError(`${key} must be a boolean`);
  }
  return value;
}

export function readInt(
  input: Record<string, unknown>,
  key: string,
  opts: { required: true; min?: number; max?: number }
): number;
export function readInt(
  input: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean; min?: number; max?: number }
): number | undefined;
export function readInt(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; min?: number; max?: number } = {}
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new InputError(`${key} is required`);
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputError(`${key} must be an integer`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new InputError(`${key} must be at least ${opts.min}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new InputError(`${key} must be at most ${opts.max}`);
  }
  return value;
}

export function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  opts: { required: true }
): T;
export function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  opts?: { required?: boolean }
): T | undefined;
export function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
  opts: { required?: boolean } = {}
): T | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new InputError(`${key} is required`);
    }
    return undefined;
  }
  // Allowed values are our own constants — safe to name; the input is not.
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new InputError(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

/** Like readInt, but keeps an explicit null so an edit can clear a target. */
export function readNullableInt(
  input: Record<string, unknown>,
  key: string,
  opts: { min: number; max: number }
): number | null | undefined {
  if (input[key] === null) return null;
  return readInt(input, key, opts);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readUuid(
  input: Record<string, unknown>,
  key: string,
  opts: { required: true }
): string;
export function readUuid(
  input: Record<string, unknown>,
  key: string,
  opts?: { required?: boolean }
): string | undefined;
export function readUuid(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean } = {}
): string | undefined {
  const value = readString(input, key, opts);
  if (value !== undefined && !UUID.test(value)) {
    throw new InputError(`${key} must be a uuid`);
  }
  return value;
}

/** A trimmed, non-empty string of at most `maxChars` characters. */
export function readText(
  input: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; maxChars: number }
): string | undefined {
  const value = readString(input, key, { required: opts.required });
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > opts.maxChars) {
    throw new InputError(`${key} must be 1 to ${opts.maxChars} characters`);
  }
  return trimmed;
}

/** A list of trimmed strings, deduplicated without regard to case, in the order given. */
export function readTextList(
  input: Record<string, unknown>,
  key: string,
  opts: { minItems: number; maxItems: number; maxChars: number; lowercase?: boolean }
): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new InputError(`${key} must be an array of strings`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new InputError(`${key} must be an array of strings`);
    }
    const trimmed = opts.lowercase ? item.trim().toLowerCase() : item.trim();
    if (trimmed.length === 0 || trimmed.length > opts.maxChars) {
      throw new InputError(`${key} entries must be 1 to ${opts.maxChars} characters`);
    }
    const folded = trimmed.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(trimmed);
  }
  if (out.length < opts.minItems || out.length > opts.maxItems) {
    throw new InputError(`${key} must hold ${opts.minItems} to ${opts.maxItems} entries`);
  }
  return out;
}
