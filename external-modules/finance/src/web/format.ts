// external-modules/finance/src/web/format.ts
// FIN-02 (#1147) Task 11: pure display helpers. Amounts are stored in cents
// with Plaid sign convention (positive = money out); formatting keeps the
// stored sign — the feed is a ledger, not a budget view (that's FIN-03).
import { decimalToCents, safeCents } from "../domain/values";
const currencyFormatters = new Map<string, Intl.NumberFormat>();

export function formatCents(amountCents: number, isoCurrency: string): string {
  let formatter = currencyFormatters.get(isoCurrency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency: isoCurrency });
    } catch {
      // Unknown/absent currency code from an upstream record: fall back to a
      // plain decimal rather than throwing mid-render.
      formatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 });
    }
    currencyFormatters.set(isoCurrency, formatter);
  }
  // ECMA-402 accepts exact decimal strings. Dividing a safe integer by 100
  // first can still lose a cent near the limit. The TS library omits strings.
  const formatDecimal = formatter.format as (value: number | string) => string;
  return formatDecimal(`${safeCents(amountCents)}E-2`);
}

/** "2026-07" → "Jul" (chart axis). */
export function shortMonthLabel(month: string): string {
  const [year = 0, monthIndex = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    timeZone: "UTC"
  });
}

const compactFormatters = new Map<string, Intl.NumberFormat>();

/** 412_000 cents → "$4.1K" (chart axis, where a rounded value is enough). */
export function formatCentsCompact(amountCents: number, isoCurrency: string): string {
  let formatter = compactFormatters.get(isoCurrency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: isoCurrency,
        notation: "compact",
        maximumFractionDigits: 1
      });
    } catch {
      formatter = new Intl.NumberFormat(undefined, {
        notation: "compact",
        maximumFractionDigits: 1
      });
    }
    compactFormatters.set(isoCurrency, formatter);
  }
  return formatter.format(amountCents / 100);
}

/** "2026-07" → "July 2026" (feed month heading). */
export function monthLabel(month: string): string {
  // Defaults satisfy noUncheckedIndexedAccess in the root test program;
  // callers always pass validated "YYYY-MM".
  const [year = 0, monthIndex = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthIndex - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

/** Shift a "YYYY-MM" month by delta months (prev/next picker). */
export function shiftMonth(month: string, delta: number): string {
  const [year = 0, monthIndex = 1] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The browser's current "YYYY-MM" (initial feed month). */
export function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// Mirrors the finance.budget-apply manifest bound (±$1M in cents): anything
// the parser lets through is guaranteed legal for the queue params gate.
const MAX_ASSIGN_CENTS = 100_000_000;

// A comma counts only as a thousands separator: one to three leading digits, then groups of
// exactly three. A decimal comma such as "12,50" fails instead of reading as 1250.
const AMOUNT_TEXT = /^-?(?:(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{0,2})?|\.\d{1,2})$/;

/**
 * Parse a user-typed assignment amount ("1,234.56", "$50", "12.50 €", "-20") into integer
 * cents (FIN-03, #1148). One currency symbol of any kind may open or close the amount and
 * spaces are ignored. Returns null (never throws) for empty text, garbage, a decimal comma,
 * sub-cent precision or an out-of-bounds amount, so the budget screen keeps its previous value
 * instead of enqueueing a bad job.
 */
export function parseAmountToCents(text: string): number | null {
  const cleaned = text
    .replace(/\s+/gu, "")
    .replace(/^(-?)\p{Sc}/u, "$1")
    .replace(/\p{Sc}$/u, "");
  if (!AMOUNT_TEXT.test(cleaned)) return null;
  try {
    const cents = decimalToCents(cleaned.replace(/,/g, ""));
    return Math.abs(cents) > MAX_ASSIGN_CENTS ? null : cents;
  } catch {
    return null;
  }
}

/** Integer cents → the plain "1234.56" form the assign input edits. */
export { centsToAmountInput } from "../domain/money-format.js";

/** "2026-07-15" → "Wednesday · July 15" (date group heading). */
export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  const weekday = parsed.toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
  const day = parsed.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
  return `${weekday} · ${day}`;
}

/** "2026-07-15" → "July 15, 2026" or "Jul 15, 2026" (chart readout and axis). */
export function dayYearLabel(date: string, month: "long" | "short"): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    month,
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

/** "2026-07-15 23:30:00 UTC" → the reader's local day, such as "Jul 16, 2026" east of UTC. */
export function instantDayLabel(instant: string): string {
  const parsed = new Date(instant.replace(" UTC", "Z").replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return instant;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "2026-07-15" → "Jul 15" (ledger date column). */
export function shortDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "2026-07-15" → "Wed, Jul 15" (bill rows inside a week group). */
export function weekdayDayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

const CADENCE_TEXT: Record<string, string> = {
  once: "Once",
  weekly: "Every week",
  fortnightly: "Every two weeks",
  monthly: "Every month",
  yearly: "Every year"
};

/** Bill cadence in the words the Add a bill form uses. */
export const cadenceText = (cadence: string) => CADENCE_TEXT[cadence] ?? cadence;
