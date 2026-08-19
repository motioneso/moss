// external-modules/food/src/domain/meal.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 3): meal + nutrient shapes. Plain
// data, no persistence and no AI concerns here — those live in
// domain/estimate.ts (boundary validation) and store/sql.ts (row mapping).
// Domain files never import @moss/* (bundler independence, matching
// external-modules/finance/src/domain/records.ts).

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

// ── Local-date resolution ───────────────────────────────────────────────
//
// Vendored rather than imported from packages/shared/src/time.ts, for the
// same bundler-independence reason as the rest of this file: this module
// ships as a single prebuilt artifact and does not depend on @moss/shared.
// The technique (en-CA Intl formatter for a locale-independent day key,
// Intl.DateTimeFormat part-diffing for the offset) is copied from
// localDay/timeZoneOffsetMs in packages/shared/src/time.ts and
// packages/wellness/src/repository.ts:556-577 respectively. Never derive a
// day with `.slice(0,10)` on a UTC ISO string or `getUTC*` parts — that is
// the server's day, not the user's.

function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Calendar date key (YYYY-MM-DD) for `date` as observed in `timeZone`. */
function localDayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/** Minutes EAST of UTC for `date` observed in `timeZone` (DST-correct: computed per-instant). */
function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(values.get("year")),
    Number(values.get("month")) - 1,
    Number(values.get("day")),
    Number(values.get("hour")),
    Number(values.get("minute")),
    Number(values.get("second"))
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

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
 */
export function resolveMealLocalDate(
  consumedAt: Date,
  timeZone: string
): { readonly localDate: string; readonly timezoneOffset: number } {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  return {
    localDate: localDayKey(consumedAt, zone),
    timezoneOffset: timeZoneOffsetMinutes(consumedAt, zone)
  };
}
