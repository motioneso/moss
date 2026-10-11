import { resolveEffectiveLocale } from "@moss/shared";

/**
 * The timezone the actor effectively lives in: the stored one when present and valid, otherwise
 * the same default `GET /api/me/locale` shows them (#2157). Use this wherever the assistant tells
 * the user what time it is.
 */
export function resolveEffectiveTimezone(raw: unknown): string {
  return resolveEffectiveLocale(raw).timezone;
}
