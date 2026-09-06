import type { JsonSchema, ToolResult } from "@moss/module-sdk";
import { renderToolResult } from "@moss/module-sdk";

import type { GatewayToolResponse } from "./types.js";

const MAX_RENDERED_TOOL_RESULT_CHARS = 16_000;

// Strip injection-vector sentinel tokens before wrapping external content.
// These patterns mirror the set used in @moss/briefings sanitizeExternal.
const SENTINEL_PATTERN =
  /<\/?tool_result[^>]*>|<\/?trusted_instructions[^>]*>|<\/?external_source[^>]*>/gi;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapWithTrustBoundary(toolName: string, text: string): string {
  const stripped = text.replace(SENTINEL_PATTERN, "");
  return `<tool_result source="${escapeHtml(toolName)}">\n${escapeHtml(stripped)}\n</tool_result>`;
}
const TOOL_RESULT_TRUNCATION_SUFFIX = "\n...[truncated tool result]";
const JSON_SCALAR_TYPE_OF: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number",
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  null: (value) => value === null
};
const JSON_NON_NULL_SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);

/**
 * Structural validation + projection for assistant-tool OUTPUT, the mirror of
 * {@link validateToolInput} for the result side. Where the input validator only
 * validates caller-supplied input (and leaves it intact), the output sanitizer
 * additionally RECONSTRUCTS the result object so only schema-declared keys reach
 * the model — an allow-list so a tool cannot leak undeclared fields into the
 * assistant context. It validates `required` keys, `type` (incl. `[scalar, null]`
 * `anyOf` nullables), and recurses into objects/arrays; it deliberately does not
 * enforce `format`/`pattern`/bounds (swap in ajv if a real schema needs those).
 */
export function sanitizeAssistantToolResult(
  schema: JsonSchema | undefined,
  result: ToolResult
): ToolResult {
  if (!isPlainObject(result.data)) {
    throw new Error("Tool result data must be an object");
  }
  if (!schema) {
    return result;
  }

  const data = sanitizeToolOutputValue(schema, result.data);
  if (!isPlainObject(data)) {
    throw new Error("Tool result data must be an object");
  }
  const allowedKeys = getDeclaredObjectKeys(schema);

  return {
    data,
    columnOrder:
      allowedKeys === null
        ? result.columnOrder
        : result.columnOrder?.filter((key) => allowedKeys.has(key))
  };
}

/**
 * Sanitize, render, and cap a tool result into a model-consumable `{text}` record.
 * Replaces the two ad-hoc sanitize+cap paths that existed in routes.ts and gateway.ts.
 *
 * When `toolName` is provided the rendered text is wrapped in a `<tool_result source="…">`
 * trust-boundary envelope: sentinel tokens are stripped and content is HTML-escaped so
 * prompt-injection attempts embedded in external data cannot escape the envelope.
 */
export function renderAndCap(
  schema: JsonSchema | undefined,
  result: ToolResult,
  toolName?: string
): Record<string, unknown> {
  const sanitized = sanitizeAssistantToolResult(schema, result);
  const text = capRenderedToolResult(renderToolResult(sanitized));
  return { text: toolName ? wrapWithTrustBoundary(toolName, text) : text };
}

/** @deprecated Use {@link renderAndCap} instead. */
export function boundedAssistantToolResultData(result: ToolResult): Record<string, unknown> {
  const rendered = renderToolResult(result);
  if (rendered.length <= MAX_RENDERED_TOOL_RESULT_CHARS) {
    return result.data;
  }
  return { text: capRenderedToolResult(rendered) };
}

export function capRenderedToolResult(text: string): string {
  if (text.length <= MAX_RENDERED_TOOL_RESULT_CHARS) {
    return text;
  }
  const keep = Math.max(0, MAX_RENDERED_TOOL_RESULT_CHARS - TOOL_RESULT_TRUNCATION_SUFFIX.length);
  return `${text.slice(0, keep)}${TOOL_RESULT_TRUNCATION_SUFFIX}`;
}

function sanitizeToolOutputValue(schema: JsonSchema, value: unknown): unknown {
  if (schema.type === "object" && isPlainObject(schema.properties)) {
    if (!isPlainObject(value)) {
      throw new Error("Tool result output field must be an object");
    }
    return sanitizeToolOutputObject(schema, value);
  }
  const itemSchema = schema.items;
  if (schema.type === "array" && isJsonSchema(itemSchema)) {
    if (!Array.isArray(value)) {
      throw new Error("Tool result output field must be an array");
    }
    return value.map((item) => sanitizeToolOutputValue(itemSchema, item));
  }
  const nullableBranch = getNullableCompoundBranch(schema);
  if (nullableBranch) {
    return value === null ? null : sanitizeToolOutputValue(nullableBranch, value);
  }
  const scalarTypes = getScalarTypes(schema);
  if (scalarTypes.length > 0) {
    const matches = scalarTypes.some((type) => JSON_SCALAR_TYPE_OF[type]?.(value));
    if (!matches) {
      throw new Error(`Tool result output field must be a ${scalarTypes.join(" or ")}`);
    }
  }
  return value;
}

function sanitizeToolOutputObject(
  schema: JsonSchema,
  value: Record<string, unknown>
): Record<string, unknown> {
  for (const key of getRequiredKeys(schema)) {
    if (!(key in value)) {
      throw new Error(`Tool result missing required output field "${key}"`);
    }
  }

  const data: Record<string, unknown> = {};
  const properties = schema.properties as Record<string, unknown>;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in value) {
      data[key] = isJsonSchema(propertySchema)
        ? sanitizeToolOutputValue(propertySchema, value[key])
        : value[key];
    }
  }
  return data;
}

function getDeclaredObjectKeys(schema: JsonSchema): Set<string> | null {
  return schema.type === "object" && isPlainObject(schema.properties)
    ? new Set(Object.keys(schema.properties))
    : null;
}

function getRequiredKeys(schema: JsonSchema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
}

function getNullableCompoundBranch(schema: JsonSchema): JsonSchema | null {
  if (!Array.isArray(schema.anyOf) || schema.anyOf.length !== 2) return null;
  const branches = schema.anyOf.filter(isJsonSchema);
  if (branches.length !== 2) return null;
  const nullBranch = branches.find((candidate) => candidate.type === "null");
  const otherBranch = branches.find((candidate) => candidate !== nullBranch);
  if (!nullBranch || !otherBranch) return null;
  const isObjectBranch = otherBranch.type === "object" && isPlainObject(otherBranch.properties);
  const isArrayBranch = otherBranch.type === "array" && isJsonSchema(otherBranch.items);
  return isObjectBranch || isArrayBranch ? otherBranch : null;
}

function getScalarTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === "string" && isJsonScalarType(schema.type)) {
    return [schema.type];
  }

  if (!Array.isArray(schema.anyOf)) {
    return [];
  }

  const types = schema.anyOf
    .filter(isJsonSchema)
    .map((candidate) => candidate.type)
    .filter((type): type is string => typeof type === "string");
  const nonNullScalarTypes = types.filter((type) => JSON_NON_NULL_SCALAR_TYPES.has(type));

  if (
    types.length === schema.anyOf.length &&
    types.length === 2 &&
    types.includes("null") &&
    nonNullScalarTypes.length === 1
  ) {
    const [nonNullScalarType] = nonNullScalarTypes;
    if (nonNullScalarType) {
      return [nonNullScalarType, "null"];
    }
  }

  return [];
}

function isJsonScalarType(type: string): type is keyof typeof JSON_SCALAR_TYPE_OF {
  return Object.prototype.hasOwnProperty.call(JSON_SCALAR_TYPE_OF, type);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return isPlainObject(value);
}

/**
 * What rides the `action_result` live stream record as `result`.
 *
 * By default this is the rendered `{ text }` the model saw — deliberately narrow, so a module
 * handler cannot push arbitrary shapes at the browser. A tool that owns an inline card opts in
 * with `streamsStructuredResult`, and then gets the schema-sanitized structured result instead
 * (`sanitizeAssistantToolResult` has already dropped every key the tool's own output schema does
 * not declare, so this widens what reaches the browser only as far as that schema).
 */
export function liveStreamResult(
  tool: { readonly streamsStructuredResult?: boolean },
  result: Extract<GatewayToolResponse, { ok: true }>
): Record<string, unknown> {
  if (tool.streamsStructuredResult === true && result.structuredData !== undefined) {
    return result.structuredData;
  }
  return result.data;
}
