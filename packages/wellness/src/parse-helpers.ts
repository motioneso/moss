import { HttpError } from "@moss/module-sdk";

/**
 * Small shared body-parsing helpers used by every wellness request parser. Lifted out of
 * routes.ts alongside the medication parsers (#1968) so both files can use them; behaviour is
 * unchanged by the move.
 */

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Expected JSON object body");
  }
  return value as Record<string, unknown>;
}
export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}
export function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  return value.trim();
}
export function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value as string[];
}
// Variant for PATCH bodies: omitted field returns undefined (leave unchanged), explicit [] clears.
export function parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string")) {
    throw new HttpError(400, `${field} must be an array of strings`);
  }
  return value as string[];
}
