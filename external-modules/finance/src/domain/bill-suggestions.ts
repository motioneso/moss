// #3877: bill suggestions from repeating posted charges. Pure; the read handler supplies the
// owner's own history, active plans and dismissals. Rules are in the 2026-10-30 design pass spec,
// slice 5.
import { billOccurrences, type BillCadence, type BillSchedule } from "./recurrence.js";
import { normalizePayee } from "./payee.js";

export type SuggestedCadence = Exclude<BillCadence, "once">;

export interface SuggestionCharge {
  id: string;
  accountId: string;
  date: string;
  name: string;
  merchant: string | null;
  /** Spending-positive cents. */
  amountCents: number;
  categoryId: string | null;
}

export interface SuggestionPlan extends BillSchedule {
  accountId: string;
  name: string;
  amountCents: number;
}

export interface SuggestionDismissal {
  accountId: string;
  payeeKey: string;
  cadence: SuggestedCadence;
  amountCents: number;
}

export interface BillSuggestionStore {
  dismissals(): Promise<SuggestionDismissal[]>;
  /** Idempotent; false when the account is not the owner's. */
  dismiss(dismissal: SuggestionDismissal, at: string): Promise<boolean>;
}

export interface BillSuggestion {
  accountId: string;
  payeeKey: string;
  name: string;
  cadence: SuggestedCadence;
  amountCents: number;
  categoryId: string | null;
  lastDate: string;
  nextDate: string;
  charges: number;
}

export const SUGGESTION_LOOKBACK_DAYS = 400;
export const SUGGESTION_LIMIT = 20;
/** The longest payee key a dismissal stores. */
export const SUGGESTION_PAYEE_KEY_MAX = 160;

/** The payee key a suggestion carries: cleaned, cut to the dismissal limit, end trimmed. */
export function suggestionPayeeKey(text: string): string {
  return Array.from(normalizePayee(text)).slice(0, SUGGESTION_PAYEE_KEY_MAX).join("").trimEnd();
}

const DAY = 86_400_000;
const TOLERANCE: Record<SuggestedCadence, number> = {
  weekly: 1,
  fortnightly: 2,
  monthly: 3,
  yearly: 7
};
const MIN_RUN: Record<SuggestedCadence, number> = {
  weekly: 3,
  fortnightly: 3,
  monthly: 3,
  yearly: 2
};
const CADENCES = Object.keys(TOLERANCE) as SuggestedCadence[];

const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const toDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Same day in the next month or year, clamped to the month's last day. */
function nextDate(day: string, cadence: SuggestedCadence): string {
  const time = toTime(day);
  if (cadence === "weekly") return toDay(time + 7 * DAY);
  if (cadence === "fortnightly") return toDay(time + 14 * DAY);
  const date = new Date(time);
  const years = cadence === "yearly" ? 1 : 0;
  const months = cadence === "monthly" ? 1 : 0;
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth() + months;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return toDay(Date.UTC(year, month, Math.min(date.getUTCDate(), last)));
}

const isMonthEnd = (day: string) => new Date(toTime(day) + DAY).getUTCDate() === 1;

/** The last day of the month after the one holding `day`. */
function nextMonthEnd(day: string): string {
  const date = new Date(toTime(day));
  return toDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0));
}

function fits(previous: string, current: string, cadence: SuggestedCadence): boolean {
  const expected = [nextDate(previous, cadence)];

  // A bill due at month end follows the last day, so a short month does not pull it earlier.
  if (cadence === "monthly" && isMonthEnd(previous)) expected.push(nextMonthEnd(previous));

  const drift = Math.min(...expected.map((day) => Math.abs(toTime(current) - toTime(day)) / DAY));
  return drift <= TOLERANCE[cadence];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

const near = (a: number, b: number, share: number) => Math.abs(a - b) <= Math.abs(b) * share;

/** The plan falls due within the cadence's tolerance of the suggestion's next date. */
const dueNear = (plan: SuggestionPlan, s: BillSuggestion) => {
  const slack = TOLERANCE[s.cadence] * DAY;
  const at = toTime(s.nextDate);
  return billOccurrences(plan, toDay(at - slack), toDay(at + slack)).length > 0;
};

/** Split one payee's charges into bands of similar amounts. Input is sorted by amount. */
function bands(charges: readonly SuggestionCharge[]): SuggestionCharge[][] {
  const result: SuggestionCharge[][] = [];
  let band: SuggestionCharge[] = [];
  for (const charge of charges) {
    const centre = band.length ? median(band.map((c) => c.amountCents)) : charge.amountCents;
    if (band.length && Math.abs(charge.amountCents - centre) > Math.max(centre * 0.1, 100)) {
      result.push(band);
      band = [];
    }
    band.push(charge);
  }
  if (band.length) result.push(band);
  return result;
}

/** The cadence and length of the regular run ending at the newest charge, if any. */
function run(dates: readonly string[]): { cadence: SuggestedCadence; length: number } | null {
  const last = dates.length - 1;
  if (last < 1) return null;
  const cadence = CADENCES.find((c) => fits(dates[last - 1]!, dates[last]!, c));
  if (!cadence) return null;
  let length = 2;
  while (length <= last && fits(dates[last - length]!, dates[last - length + 1]!, cadence))
    length += 1;
  return length >= MIN_RUN[cadence] ? { cadence, length } : null;
}

export function suggestBills(input: {
  charges: readonly SuggestionCharge[];
  plans: readonly SuggestionPlan[];
  dismissals: readonly SuggestionDismissal[];
  today: string;
}): BillSuggestion[] {
  const groups = new Map<string, { payeeKey: string; charges: SuggestionCharge[] }>();
  for (const charge of input.charges) {
    if (!(charge.amountCents > 0)) continue;
    const payeeKey = suggestionPayeeKey(charge.merchant ?? charge.name);
    if (!payeeKey) continue;
    const id = `${charge.accountId}\u0000${payeeKey}`;
    const group = groups.get(id) ?? { payeeKey, charges: [] };
    group.charges.push(charge);
    groups.set(id, group);
  }

  const suggestions: BillSuggestion[] = [];
  for (const { payeeKey, charges } of groups.values()) {
    const byAmount = [...charges].sort((a, b) => a.amountCents - b.amountCents);
    for (const band of bands(byAmount)) {
      const byDate = [...band].sort(
        (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
      );
      const found = run(byDate.map((c) => c.date));
      if (!found) continue;
      const newest = byDate[byDate.length - 1]!;
      const next = nextDate(newest.date, found.cadence);
      if ((toTime(input.today) - toTime(next)) / DAY > TOLERANCE[found.cadence]) continue;
      suggestions.push({
        accountId: newest.accountId,
        payeeKey,
        name: (newest.merchant ?? newest.name).trim(),
        cadence: found.cadence,
        amountCents: newest.amountCents,
        categoryId:
          newest.categoryId && newest.categoryId !== "uncategorized" ? newest.categoryId : null,
        lastDate: newest.date,
        nextDate: next,
        charges: found.length
      });
    }
  }

  return suggestions
    .filter(
      (s) =>
        !input.plans.some(
          (plan) =>
            plan.accountId === s.accountId &&
            (suggestionPayeeKey(plan.name) === s.payeeKey ||
              (plan.cadence === s.cadence &&
                near(plan.amountCents, s.amountCents, 0.25) &&
                dueNear(plan, s)))
        ) &&
        !input.dismissals.some(
          (d) =>
            d.accountId === s.accountId &&
            d.payeeKey === s.payeeKey &&
            d.cadence === s.cadence &&
            near(s.amountCents, d.amountCents, 0.25)
        )
    )
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.payeeKey.localeCompare(b.payeeKey))
    .slice(0, SUGGESTION_LIMIT);
}
