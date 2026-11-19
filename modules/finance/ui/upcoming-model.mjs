// Pure helpers for the Upcoming screen. Dates are YYYY-MM-DD strings, amounts whole cents.
import { formatCents, shortDayLabel } from "./format.mjs";

const day = (date) => new Date(`${date}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

export const monthWindow = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: iso(new Date(Date.UTC(y, m, 0))) };
};

export const occurrenceDate = (o) => o.plannedDate ?? o.dueDate;
export const occurrenceKey = (o) => `${o.planId}:${o.dueDate}`;
const pastDue = (o, today) => o.state === "projected" && occurrenceDate(o) < today;

export function stateLabel(o, view) {
  if (o.state === "projected") return pastDue(o, view.today) ? "Past due · projected" : "Projected";
  if (o.state === "posted") return `Posted ${formatCents(o.actualCents, view.isoCurrency)}`;
  return o.state === "skipped" ? "Skipped" : "Match needs review";
}

/** A bill still due on time needs no badge in the list. */
export const quietState = (o, view) => o.state === "projected" && !pastDue(o, view.today);

/** Month totals. Skipped bills count nowhere. */
export function billTotals(occurrences) {
  let paid = 0;
  let toGo = 0;
  for (const o of occurrences) {
    if (o.state === "posted") paid += o.actualCents ?? 0;
    else if (o.state !== "skipped") toGo += o.expectedCents;
  }
  return { due: paid + toGo, paid, toGo };
}

export const weekdayDayLabel = (date) =>
  day(date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });

/** Groups a month's bills into Monday-to-Sunday weeks, each sorted by day then name. */
export function weeksOf(occurrences) {
  const groups = new Map();
  const sorted = [...occurrences].sort(
    (a, b) => occurrenceDate(a).localeCompare(occurrenceDate(b)) || a.name.localeCompare(b.name)
  );
  for (const o of sorted) {
    const d = day(occurrenceDate(o));
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    const key = iso(monday);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups].map(([start, items]) => {
    const end = iso(new Date(day(start).getTime() + 6 * 86400000));
    return { start, label: `${shortDayLabel(start)} – ${shortDayLabel(end)}`, items };
  });
}

export const accountName = (view, id) =>
  view.accounts.find((a) => a.accountId === id)?.name ?? "Unavailable account";
export const categoryName = (view, id) =>
  view.categories.find((c) => c.id === id)?.name ?? "Archived category";

const CADENCE = {
  once: "one time",
  weekly: "weekly",
  fortnightly: "every two weeks",
  monthly: "monthly",
  yearly: "yearly"
};
export const cadenceLabel = (c) => CADENCE[c] ?? c;

/** Plans that still produce bills on or after today. */
export const livePlans = (view) => view.plans.filter((p) => !p.endDate || p.endDate >= view.today);

export const occurrenceBy = (view, key) =>
  view.occurrences.find((o) => occurrenceKey(o) === key) ?? null;

/** Every bill write carries the revision and fingerprint of the last read. */
export const reviewOf = (view) => ({
  expectedRevision: view.revision,
  expectedFingerprint: view.fingerprint
});
