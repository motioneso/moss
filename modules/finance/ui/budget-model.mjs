// Turns a budget status reply into the groups and lines the Budget screen shows.
import { formatCents, parseAmountToCents, centsToAmountInput } from "./format.mjs";

const GROUPS = ["Flexible", "Fixed", "Non-monthly", "Bills", "Everyday", "Fun", "Savings"];
const NOT_ENVELOPES = new Set(["income", "transfers"]);
const ZERO = { assignedCents: 0, activityCents: 0, availableCents: 0 };

export function buildGroups(result) {
  const states = result.state?.categories ?? {};
  const categories = (result.categories ?? []).filter(
    (c) =>
      !NOT_ENVELOPES.has(c.id) &&
      (!c.archived || Object.values(states[c.id] ?? ZERO).some((cents) => cents !== 0))
  );
  return GROUPS.map((name) => ({
    name,
    lines: categories
      .filter((c) => c.tableGroup === name)
      .map((c) => {
        const row = states[c.id] ?? ZERO;
        const carry = row.availableCents - row.assignedCents + row.activityCents;
        return {
          id: c.id,
          currency: result.isoCurrency ?? "",
          name: c.name,
          assigned: row.assignedCents,
          spent: row.activityCents,
          available: row.availableCents,
          carried: Number.isSafeInteger(carry) ? Math.max(0, carry) : null,
          archived: c.archived === true
        };
      })
  })).filter((g) => g.lines.length > 0);
}

/** The text an assigned field starts with, plain when the money format would not read back. */
export function amountFieldText(cents, currency) {
  const shown = formatCents(cents, currency);
  return parseAmountToCents(shown) === cents ? shown : centsToAmountInput(cents);
}

export const meterWidth = ({ assigned, spent }) =>
  Math.round((assigned <= 0 ? (spent > 0 ? 1 : 0) : Math.min(1, spent / assigned)) * 100);

export const overspent = (groups) =>
  groups.flatMap((g) => g.lines).filter((l) => l.available < 0);

export function groupAssigned(group) {
  const total = group.lines.reduce((sum, l) => sum + l.assigned, 0);
  return Number.isSafeInteger(total) ? formatCents(total, group.lines[0].currency) : "Unavailable";
}

/** Plain words for a refused or failed save. */
export function saveFailure(error) {
  if (error?.code === "stale_budget" || error?.code === "stale_previous") {
    return "Not saved. The budget may have changed. Refresh and review your typed amount.";
  }
  if (Number.isInteger(error?.status) && error.status < 500 && error.detail) return error.detail;
  return "The save could not be confirmed. Check saved records before trying again. Your typed amount is kept.";
}
