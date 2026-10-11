// external-modules/finance/src/worker/validate.ts
//
// FIN-01 (#1146): tool-input readers, ported from job-search. Every error
// names the offending KEY and the violated CONSTRAINT only — never the
// value. Validation errors flow back through RPC results where echoed
// content would leak (same discipline as FinanceKvError).

export class InputError extends Error {
  readonly code: string;

  /**
   * One-arg form keeps the classic validation code ("invalid_input");
   * two-arg form names a handler-level condition (Task 5, #1146:
   * "needs_config", "token_read_failed") that callers key remediation on.
   */
  constructor(codeOrMessage: string, message?: string) {
    super(message ?? codeOrMessage);
    this.name = "InputError";
    this.code = message === undefined ? "invalid_input" : codeOrMessage;
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
    // Fixed copy — never the computed size, never the content.
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
  // Number.isInteger rejects NaN, Infinity, and fractional values in one check.
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

/**
 * Ids of the active (not deleted or deactivated) members, host-injected into
 * tool input next to actorUserId. A missing or malformed value yields an empty
 * set, so household reads fail closed and drop every other owner's data.
 */
export function readActiveUserIds(input: Record<string, unknown>): ReadonlySet<string> {
  const value = input.activeUserIds;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((id): id is string => typeof id === "string"));
}
