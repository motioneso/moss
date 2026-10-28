import { FinanceKvError } from "./errors.js";

/** Stored money remains integer hundredths; this does not introduce FX conversion. */
export function safeCents(value: string | number): number {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) {
    throw new FinanceKvError("invalid_record", "money must be safe integer hundredths");
  }
  return cents;
}

/** Refuse overflow instead of silently rounding accumulated financial totals. */
export function addCents(left: number, right: number): number {
  return safeCents(safeCents(left) + safeCents(right));
}

export function requireSingleCurrency(currencies: Iterable<string>): void {
  if (new Set(currencies).size > 1)
    throw new FinanceKvError("invalid_record", "Choose one currency before aggregating money");
}

/** Decimal conversion, rounded half away from zero, before entering the ledger. */
export function decimalToCents(value: number | string): number {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new FinanceKvError("invalid_record", "money must be finite");
  }
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match || !(match[2] || match[3])) {
    throw new FinanceKvError("invalid_record", "money must be decimal");
  }
  const fraction = match[3] ?? "";
  const shift = 2 + Number(match[4] ?? 0) - fraction.length;
  // Bound exponent before constructing powers (also bounds hostile text input).
  if (Math.abs(shift) > 400 || String(value).length > 500) {
    throw new FinanceKvError("invalid_record", "money is outside supported precision");
  }
  let cents = BigInt(`${match[2]}${fraction}`);
  if (shift >= 0) cents *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    cents = (cents + divisor / 2n) / divisor;
  }
  if (match[1]) cents = -cents;
  return safeCents(Number(cents));
}

export function isCalendarMonth(value: string): boolean {
  return /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isCalendarMonth(value.slice(0, 7))) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}
