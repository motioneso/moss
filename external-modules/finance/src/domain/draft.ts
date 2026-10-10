// external-modules/finance/src/domain/draft.ts
//
// #3180 (Finance R1): the deterministic first-budget draft. Every number is a
// function of the stored transactions and categories; nothing here calls a
// model and nothing reads a clock (the caller passes `currentMonth`).
// Spending-positive integer cents throughout (FIN-01 record convention).
import type { TransactionRecord } from "./records.js";
import { tableGroupFor, type Category, type CategoryGroupName } from "./taxonomy.js";
import { effectiveTransferIds } from "./transfers.js";

/** How many complete months of history the draft reads at most. */
export const DRAFT_BASIS_MONTHS = 3;
/** A plan amount rounds up to the next five dollars. */
export const ROUND_UP_CENTS = 500;
/** Steady means each basis month has a charge within 10% of the same amount. */
export const STEADY_TOLERANCE = 0.1;

export interface DraftLineInput {
  categoryKey: string;
  groupName: string;
  categoryName: string;
  basisMonthlyCents: number;
  proposedCents: number;
}

export interface DraftBuild {
  basisFrom: string;
  basisTo: string;
  monthlyIncomeCents: number;
  lines: DraftLineInput[];
}

/** Draft line as stored and read back. */
export interface DraftLine extends DraftLineInput {
  adjustedCents: number | null;
  adjustedBy: "user" | "moss" | null;
  dropped: boolean;
}

export interface BudgetDraft {
  id: string;
  status: "open" | "started" | "discarded";
  basisFrom: string;
  basisTo: string;
  monthlyIncomeCents: number;
  createdAt: string;
  startedAt: string | null;
  lines: DraftLine[];
}

export function roundUpToFiveDollars(cents: number): number {
  return Math.ceil(cents / ROUND_UP_CENTS) * ROUND_UP_CENTS;
}

/** The amount a line plans: the adjusted amount when one was set, else the proposal. */
export function linePlanCents(line: DraftLine): number {
  return line.adjustedCents ?? line.proposedCents;
}

/** Sum of the plan amounts over lines that are not dropped. */
export function draftTotalCents(lines: readonly DraftLine[]): number {
  let total = 0;
  for (const line of lines) if (!line.dropped) total += linePlanCents(line);
  return total;
}

/** Monthly income minus the draft total; negative means the plan is over income. */
export function draftUnplannedCents(
  draft: Pick<BudgetDraft, "monthlyIncomeCents" | "lines">
): number {
  return draft.monthlyIncomeCents - draftTotalCents(draft.lines);
}

/** Groups a draft line can sit in. */
export const DRAFT_LINE_GROUPS = ["Bills", "Everyday", "Fun", "Savings"] as const;
/** Category keys are short lowercase slugs. */
export const DRAFT_CATEGORY_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Largest plan amount a line accepts (cents). */
export const DRAFT_AMOUNT_MAX_CENTS = 100_000_000;

export interface DraftLineEdit {
  amountCents?: number;
  categoryName?: string;
  groupName?: string;
  dropped?: boolean;
}

/**
 * Apply one edit to a draft line and return the new line. An amount un-drops the line
 * unless the same edit says otherwise. An edit that sets an amount or drops the line
 * records who made it; a rename or regroup alone leaves that record alone.
 * A line that does not exist yet starts empty, so the caller must supply its name,
 * group and amount.
 */
export function applyLineEdit(
  categoryKey: string,
  existing: DraftLine | undefined,
  edit: DraftLineEdit,
  by: "user" | "moss"
): DraftLine {
  const changesPlan = edit.amountCents !== undefined || edit.dropped !== undefined;
  const base: DraftLine = existing ?? {
    categoryKey,
    groupName: "",
    categoryName: "",
    basisMonthlyCents: 0,
    proposedCents: 0,
    adjustedCents: null,
    adjustedBy: null,
    dropped: false
  };
  return {
    ...base,
    groupName: edit.groupName ?? base.groupName,
    categoryName: edit.categoryName ?? base.categoryName,
    adjustedCents: edit.amountCents ?? base.adjustedCents,
    adjustedBy: changesPlan ? by : base.adjustedBy,
    dropped: edit.dropped ?? (edit.amountCents !== undefined ? false : base.dropped)
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Pick the basis months: the newest complete months before `currentMonth`
 * (at most three, oldest first). With no complete month, the current month's
 * partial history stands in so a new account still gets a draft.
 */
export function pickBasisMonths(monthsWithData: readonly string[], currentMonth: string): string[] {
  const sorted = [...new Set(monthsWithData)].sort();
  const complete = sorted.filter((month) => month < currentMonth).slice(-DRAFT_BASIS_MONTHS);
  if (complete.length > 0) return complete;
  return sorted.includes(currentMonth) ? [currentMonth] : [];
}

function lastDayOfMonth(month: string): string {
  const [year = 0, monthIndex = 1] = month.split("-").map(Number);
  const day = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

function merchantKey(txn: TransactionRecord): string {
  return (txn.merchant ?? txn.name).trim().toLowerCase();
}

/**
 * True when the merchant has a charge in every basis month and every month's
 * largest charge sits within 10% of the first month's. One basis month proves
 * nothing, so steadiness needs at least two.
 */
function isSteady(amountsByMonth: Map<string, number[]>, months: readonly string[]): boolean {
  if (months.length < 2) return false;
  const reference: number[] = [];
  for (const month of months) {
    const amounts = amountsByMonth.get(month);
    if (!amounts || amounts.length === 0) return false;
    reference.push(Math.max(...amounts));
  }
  const anchor = reference[0] as number;
  if (anchor <= 0) return false;
  return reference.every((amount) => Math.abs(amount - anchor) <= anchor * STEADY_TOLERANCE);
}

/**
 * Build the draft from transactions already loaded by month. Pending rows,
 * transfers (paired or categorised) and uncategorised rows are left out.
 * Returns null when there is no history to read.
 */
export function buildDraft(input: {
  transactionsByMonth: Readonly<Record<string, readonly TransactionRecord[]>>;
  categories: readonly Category[];
  currentMonth: string;
}): DraftBuild | null {
  const basisMonths = pickBasisMonths(Object.keys(input.transactionsByMonth), input.currentMonth);
  if (basisMonths.length === 0) return null;

  const rows = basisMonths.flatMap((month) => [...(input.transactionsByMonth[month] ?? [])]);
  const excluded = effectiveTransferIds(rows);
  const byId = new Map(input.categories.map((category) => [category.id, category] as const));

  const spendByCategory = new Map<string, number>();
  const merchantsByCategory = new Map<string, Map<string, Map<string, number[]>>>();
  const incomeByMonth = new Map<string, number>();

  for (const month of basisMonths) {
    for (const txn of input.transactionsByMonth[month] ?? []) {
      if (txn.pending || txn.categoryId === null || excluded.has(txn.id)) continue;
      if (txn.categoryId === "transfers") continue;
      if (txn.categoryId === "income") {
        incomeByMonth.set(month, (incomeByMonth.get(month) ?? 0) - txn.amountCents);
        continue;
      }
      spendByCategory.set(
        txn.categoryId,
        (spendByCategory.get(txn.categoryId) ?? 0) + txn.amountCents
      );
      if (txn.amountCents > 0) {
        const merchants =
          merchantsByCategory.get(txn.categoryId) ?? new Map<string, Map<string, number[]>>();
        const months = merchants.get(merchantKey(txn)) ?? new Map<string, number[]>();
        months.set(month, [...(months.get(month) ?? []), txn.amountCents]);
        merchants.set(merchantKey(txn), months);
        merchantsByCategory.set(txn.categoryId, merchants);
      }
    }
  }

  const lines: DraftLineInput[] = [];
  for (const [categoryId, spendCents] of spendByCategory) {
    const category = byId.get(categoryId);
    if (!category || category.archived || spendCents <= 0) continue;
    const basisMonthlyCents = Math.round(spendCents / basisMonths.length);
    if (basisMonthlyCents <= 0) continue;

    // A category whose spend is mostly steady merchants is a bill, whatever its group.
    let group: CategoryGroupName = tableGroupFor(category.group);
    if (group !== "Bills") {
      let steadyCents = 0;
      let totalCents = 0;
      for (const months of merchantsByCategory.get(categoryId)?.values() ?? []) {
        const sum = [...months.values()].flat().reduce((acc, amount) => acc + amount, 0);
        totalCents += sum;
        if (isSteady(months, basisMonths)) steadyCents += sum;
      }
      if (totalCents > 0 && steadyCents * 2 >= totalCents) group = "Bills";
    }

    lines.push({
      categoryKey: category.id,
      groupName: group,
      categoryName: category.name,
      basisMonthlyCents,
      proposedCents: roundUpToFiveDollars(basisMonthlyCents)
    });
  }
  lines.sort((a, b) => a.categoryKey.localeCompare(b.categoryKey));

  const incomeMonths = basisMonths
    .map((month) => incomeByMonth.get(month) ?? 0)
    .filter((value) => value > 0);
  return {
    basisFrom: `${basisMonths[0] as string}-01`,
    basisTo: lastDayOfMonth(basisMonths[basisMonths.length - 1] as string),
    monthlyIncomeCents: median(incomeMonths),
    lines
  };
}
