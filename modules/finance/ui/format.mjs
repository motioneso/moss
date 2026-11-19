// Pure display and input helpers. Amounts are whole cents.
const formatters = new Map();

export function formatCents(cents, currency) {
  let formatter = formatters.get(currency);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    } catch {
      formatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 });
    }
    formatters.set(currency, formatter);
  }
  return formatter.format(`${Math.trunc(cents)}E-2`);
}

const parts = (month) => month.split("-").map(Number);
const utc = (date) => new Date(`${date}T00:00:00Z`);

export function monthLabel(month) {
  const [year, index] = parts(month);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

export function shortMonthLabel(month) {
  const [year, index] = parts(month);
  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    timeZone: "UTC"
  });
}

export function shiftMonth(month, delta) {
  const [year, index] = parts(month);
  const moved = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const thisMonth = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

/** Transactions opens on the month just ended during the first week of a month. */
export function defaultLedgerMonth(now = new Date()) {
  return now.getDate() <= 7 ? shiftMonth(thisMonth(now), -1) : thisMonth(now);
}

export function shortDayLabel(date) {
  const parsed = utc(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dayYearLabel(date) {
  const parsed = utc(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

const MAX_ASSIGN_CENTS = 100_000_000;
const AMOUNT_TEXT = /^-?(?:(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{0,2})?|\.\d{1,2})$/;

/** "1,234.56", "$50" or "-20" into whole cents, or null when the text is not an amount. */
export function parseAmountToCents(text) {
  const cleaned = String(text)
    .replace(/\s+/gu, "")
    .replace(/^(-?)\p{Sc}/u, "$1")
    .replace(/\p{Sc}$/u, "");
  if (!AMOUNT_TEXT.test(cleaned)) return null;
  const negative = cleaned.startsWith("-");
  const [whole, fraction = ""] = cleaned.replace(/^-/, "").replace(/,/g, "").split(".");
  const cents = Number(whole || "0") * 100 + Number(fraction.padEnd(2, "0"));
  const signed = negative ? -cents : cents;
  return Math.abs(signed) > MAX_ASSIGN_CENTS ? null : signed;
}

/** Whole cents into the plain "1234.56" the assigned field edits. */
export function centsToAmountInput(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
