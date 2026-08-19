// external-modules/food/src/tools/validate.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 4): tool-input readers, vendored
// from external-modules/finance/src/worker/validate.ts (readString/readBool/
// readInt/readEnum + InputError) and external-modules/job-search/src/worker/
// validate.ts (stripEnvelope). Modules may import only @moss/module-sdk,
// @moss/module-web-sdk, and @moss/host-fetch — never @moss/shared — so this
// is a copy, not an import, per constraint 1 (team-lead, #926 build brief).
// Every error names the offending KEY and the violated CONSTRAINT only —
// never the value — matching both source files' discipline.

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

/** Finite, non-negative check shared by every nutrient reader below — nutrient corrections are
 * user-authored (trusted, not run through domain/estimate.ts's model-output ceiling sanitizer;
 * see store/sql.ts's correctMeal doc comment) but must still reject a value that would corrupt a
 * downstream sum (constraint 6: nutrients are nullable and never coalesced to/from 0). */
export function readNutrientValue(
  input: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new InputError(`${key} must be a non-negative finite number or null`);
  }
  return value;
}
