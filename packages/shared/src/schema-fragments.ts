// Shared JSON-schema fragments for the REST contract layer.
//
// These were previously duplicated as file-local `const`s across the per-module *-api.ts files.
// They are consolidated here so the contract is defined once. This module is part of the
// Vite-bundled @moss/shared package — keep it free of `node:*` imports.

/** Canonical error envelope for non-2xx responses: `{ error: string }`, closed to extra keys. */
export const errorResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  properties: {
    error: { type: "string" },
    code: { type: "string" }
  }
} as const;

/**
 * A deliberately-open JSON object. `additionalProperties: true` is intentional: the value space
 * is producer-defined (e.g. recurrence specs, connector metadata blobs). Do NOT tighten this to
 * `false` — callers rely on passing module-specific keys through untouched.
 */
export const jsonObjectSchema = {
  type: "object",
  additionalProperties: true
} as const;

/** Nullable variant of {@link jsonObjectSchema}. */
export const nullableJsonObjectSchema = {
  anyOf: [jsonObjectSchema, { type: "null" }]
} as const;

/** Nullable string fragment used pervasively in DTO schemas. */
export const nullableStringSchema = {
  anyOf: [{ type: "string" }, { type: "null" }]
} as const;

/** Path-params shape for routes keyed by a single `id`, closed to extra keys. */
export const idParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string" }
  }
} as const;
