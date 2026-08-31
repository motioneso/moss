// external-modules/food/src/domain/meal.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 3): meal + nutrient shapes. Plain
// data, no persistence and no AI concerns here — those live in
// domain/estimate.ts (boundary validation) and store/sql.ts (row mapping).
// Domain files never import @moss/* (bundler independence, matching
// external-modules/finance/src/domain/records.ts) — with one exception,
// @moss/module-sdk, which the bundler already inlines into every module's
// dist and which every module's worker entry already imports. Sharing code
// through the SDK is what it is for (#1723); the rule exists to stop a
// module depending on host packages it does not ship with, and the SDK is
// not one of those.
import { resolveLocalDay, strictLocalWallClockToInstant } from "@moss/module-sdk/time";

export type CaptureKind = "text" | "photo" | "voice";
export type EstimateState = "pending" | "needs_details" | "estimated" | "failed";

/**
 * Every field nullable by design — the "never zero" rule in TypeScript form.
 * `null` means unknown/not-yet-estimated, never 0. See domain/totals.ts for
 * why that distinction matters when summing a day.
 */
export interface Nutrients {
  readonly caloriesKcal: number | null;
  readonly proteinG: number | null;
  readonly carbohydratesG: number | null;
  readonly fatG: number | null;
  readonly fiberG: number | null;
  readonly sugarG: number | null;
  readonly sodiumMg: number | null;
}

/**
 * One individual food inside a meal (#1737). `label` is the food as identified
 * ("hot wings"); `portionNote` is the amount as described ("6", "32 oz"), kept
 * separate so a later database lookup has a quantity to resolve against.
 *
 * A meal's nutrients are the SUM of its items (see sumItemNutrients in
 * totals.ts) — never a separately estimated figure, so the parts and the whole
 * cannot disagree.
 */
export interface MealItem {
  readonly label: string;
  readonly portionNote: string | null;
  readonly nutrients: Nutrients;
}

export interface Meal {
  readonly mealId: string;
  /** Instant the meal was eaten, as an ISO string. */
  readonly consumedAt: string;
  /**
   * Calendar day the meal is pinned to, resolved once at create time via
   * resolveMealLocalDate and persisted — never re-derived from consumedAt at
   * read time. See resolveMealLocalDate's doc comment below in this file's
   * sibling, store/sql.ts, for why.
   */
  readonly localDate: string;
  /** Minutes east of UTC at create time, persisted alongside localDate. */
  readonly timezoneOffset: number;
  readonly description: string;
  /** The user's serving qualifier, persisted so a retry reproduces the original input. */
  readonly servingNote: string | null;
  readonly captureKind: CaptureKind;
  readonly estimateState: EstimateState;
  /** Optimistic-lock counter. Guards every mutation to this meal (see store/sql.ts). */
  readonly estimateRevision: number;
  /**
   * Null unless estimateState is "estimated". Always the sum of `items` when
   * items are present (#1737) — nothing writes this from a model value directly.
   */
  readonly nutrients: Nutrients | null;
  /**
   * The individual foods this meal was broken into, in the order they were
   * identified. Empty for a meal that has not estimated yet, and for meals
   * logged before the breakdown existed.
   */
  readonly items: readonly MealItem[];
  /** Set only when estimateState is "needs_details". */
  readonly missingDetails: string | null;
}

/**
 * Sum of one owner's meals on one localDate. Computed in TypeScript from
 * persisted records (domain/totals.ts) — never a SQL SUM, so the "never
 * coalesce to 0" rule is enforced in one place.
 */
export interface DailyTotals {
  readonly localDate: string;
  readonly nutrients: Nutrients;
  /** True when any meal on this day lacks a completed estimate. */
  readonly incomplete: boolean;
  readonly mealsWithoutEstimate: number;
}

const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ISO_OFFSET_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(?:Z|[+-]\d{2}:\d{2})$/;

function hasValidCalendarParts(raw: string): boolean {
  const match = ISO_DATE_TIME_PATTERN.exec(raw.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ""));
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const maxDay = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= maxDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59)
  );
}

/**
 * Parses the two timestamp forms accepted at Food's write boundary. Exact instants keep their
 * supplied offset; local wall clocks go through the SDK's strict DST-aware conversion.
 */
export function parseConsumedAtInstant(raw: string, effectiveZone: string): Date {
  if (ISO_OFFSET_PATTERN.test(raw)) {
    const parsed = new Date(raw);
    if (!hasValidCalendarParts(raw) || Number.isNaN(parsed.getTime())) {
      throw new Error("consumedAt must be a valid ISO instant");
    }
    return parsed;
  }
  if (ISO_DATE_TIME_PATTERN.test(raw)) {
    return strictLocalWallClockToInstant(raw, effectiveZone);
  }
  throw new Error("consumedAt must be an ISO instant or offset-less local date-time");
}

// ── Local-date resolution ───────────────────────────────────────────────
//
// #1723 item 1: this used to be about fifty lines of vendored Intl arithmetic,
// copied here because packages/shared is not available to a module that ships
// as a single prebuilt artifact. That reason does not apply to
// @moss/module-sdk — the SDK is bundled into every module's dist — so the
// helpers moved there and Food is now the first caller rather than the only
// owner. See packages/module-sdk/src/time.ts.

/**
 * Resolves the calendar day + UTC offset a meal is PINNED to at create time.
 * Both are persisted (food_meals.local_date, .timezone_offset) and never
 * recomputed at read time — so a later change to the user's configured
 * timezone cannot reshuffle which day a past meal appears on (plan §4 Task
 * 7 test 5), and offset arithmetic is computed fresh per-instant rather than
 * assuming a fixed zone, so a meal logged across a DST transition still
 * lands on the correct local date (test 6). Falls back to UTC for an
 * invalid timeZone, matching packages/shared/src/time.ts's resolveTimeZone
 * fallback behaviour.
 *
 * Kept as a named wrapper rather than re-exporting the SDK's `resolveLocalDay`
 * directly: the persisted column is `timezone_offset`, and renaming the field
 * to the SDK's `timezoneOffsetMinutes` across the store, the tools and the web
 * surface would be a rename with no behaviour behind it.
 */
export function resolveMealLocalDate(
  consumedAt: Date,
  timeZone: string
): { readonly localDate: string; readonly timezoneOffset: number } {
  const { localDate, timezoneOffsetMinutes } = resolveLocalDay(consumedAt, timeZone);
  return { localDate, timezoneOffset: timezoneOffsetMinutes };
}
