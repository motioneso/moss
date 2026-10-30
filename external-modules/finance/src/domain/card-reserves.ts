import type { AccountRecord, TransactionRecord } from "./records.js";
import type { BudgetMonthStateCore } from "./envelope.js";
import type { CardReservePolicy, CardReserveAssignment } from "./card-reserve-store.js";
import { allocations } from "./splits.js";
import { FLEX_POOL, flexForMonth, type FlexPolicy } from "./flex.js";
import { effectiveTransferIds } from "./transfers.js";
import { countsTowardReady, signedBalanceCents, type BalanceLike } from "./ready-to-assign.js";
import { safeCents } from "./values.js";

export interface CardPaymentState {
  accountId: string;
  startingDebtCents: number;
  owedCents: number;
  assignedCents: number;
  fundedCents: number;
  refundsCents: number;
  paymentsCents: number;
  unfundedCents: number;
  availableCents: number;
}
interface Contribution {
  accountId: string;
  categoryId: string;
  cents: bigint;
}
const positive = (value: bigint) => (value > 0n ? value : 0n);
const abs = (value: bigint) => (value < 0n ? -value : value);
const money = (value: number) => BigInt(safeCents(value));

/** Exact signed proportional allocation, including mixed-sign splits. Stable ties use input order. */
export function allocateCardCents(
  parts: readonly number[],
  numerator: number,
  denominator: number
) {
  const n = abs(money(numerator)),
    d = abs(money(denominator));
  if (!d) return parts.map(() => 0);
  if (n > d) throw new Error("Card debt movement exceeds the transaction amount");
  const raw = parts.map((part) => money(part) * n);
  const result = raw.map((part) => part / d);
  let remaining = money(numerator) - result.reduce((sum, part) => sum + part, 0n);
  const order = raw
    .map((part, i) => ({ i, remainder: part % d }))
    .sort((a, b) =>
      abs(a.remainder) === abs(b.remainder)
        ? a.i - b.i
        : abs(a.remainder) > abs(b.remainder)
          ? -1
          : 1
    );
  for (const { i, remainder } of order) {
    if (remaining > 0n && remainder > 0n) {
      result[i]! += 1n;
      remaining--;
    } else if (remaining < 0n && remainder < 0n) {
      result[i]! -= 1n;
      remaining++;
    }
  }
  if (remaining !== 0n) throw new Error("Card allocations do not balance");
  return result.map(safeCents);
}

export interface CardReserveInput {
  accounts: readonly AccountRecord[];
  rows: readonly TransactionRecord[];
  policies: readonly CardReservePolicy[];
  assignments: readonly CardReserveAssignment[];
  ordinary: Record<string, BudgetMonthStateCore>;
  flexPolicies?: readonly FlexPolicy[];
  through: string;
  transferIds?: ReadonlySet<string>;
}
/** Pure posted-ledger derivation. Caller supplies scoped rows and canonical ordinary envelopes. */
export function deriveCardReserves(input: CardReserveInput): Record<string, CardPaymentState[]> {
  if (!input.policies.length)
    return Object.fromEntries(Object.keys(input.ordinary).map((month) => [month, []]));
  const policies = new Map(input.policies.map((p) => [p.accountId, p]));
  if (policies.size !== input.policies.length) throw new Error("Duplicate card reserve policy");
  const accounts = new Map(input.accounts.map((a) => [a.accountId, a]));
  const balances = new Map<string, bigint>();
  for (const policy of policies.values()) {
    const account = accounts.get(policy.accountId);
    if (
      account?.source !== "manual" ||
      account.type !== "credit" ||
      account.openingBalanceCents === undefined
    )
      throw new Error("Payment reserves require a manual credit card with an opening balance");
    balances.set(policy.accountId, money(account.openingBalanceCents));
  }
  const rows = input.rows
    .filter((r) => !r.pending && r.date <= input.through)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const excluded = input.transferIds ?? effectiveTransferIds([...rows]);
  const pairs = new Map<string, TransactionRecord[]>();
  for (const row of rows)
    if (row.transferId) {
      const pair = pairs.get(row.transferId) ?? [];
      pair.push(row);
      pairs.set(row.transferId, pair);
    }
  const rowsByMonth = new Map<string, TransactionRecord[]>();
  for (const row of rows) {
    const month = row.date.slice(0, 7),
      bucket = rowsByMonth.get(month) ?? [];
    bucket.push(row);
    rowsByMonth.set(month, bucket);
  }
  const months = [
    ...new Set([
      ...Object.keys(input.ordinary),
      ...rowsByMonth.keys(),
      ...input.policies.map((p) => p.effectiveMonth),
      ...input.assignments.map((a) => a.month)
    ])
  ].sort();
  const result: Record<string, CardPaymentState[]> = {};
  const carry = new Map<string, bigint>();
  for (const month of months) {
    const current = new Map<string, CardPaymentState>();
    for (const policy of policies.values())
      if (policy.effectiveMonth <= month) {
        current.set(policy.accountId, {
          accountId: policy.accountId,
          startingDebtCents: safeCents(positive(balances.get(policy.accountId)!)),
          owedCents: 0,
          assignedCents: 0,
          fundedCents: 0,
          refundsCents: 0,
          paymentsCents: 0,
          unfundedCents: 0,
          availableCents: 0
        });
      }
    const contributions: Contribution[] = [];
    const flex = flexForMonth(input.flexPolicies ?? [], month);
    for (const row of rowsByMonth.get(month) ?? []) {
      if (!policies.has(row.accountId)) continue;
      const account = accounts.get(row.accountId)!;
      if (
        row.isoCurrency !== account.isoCurrency ||
        (account.openingDate && row.date < account.openingDate)
      )
        throw new Error(
          "Repair the card ledger currency or opening date before reserving payment cash"
        );
      const before = balances.get(row.accountId)!,
        after = before + money(row.amountCents);
      safeCents(after);
      balances.set(row.accountId, after);
      const state = current.get(row.accountId);
      if (!state) continue;
      if (excluded.has(row.id)) {
        const pair = row.transferId ? pairs.get(row.transferId) : undefined;
        if (
          !pair ||
          pair.length !== 2 ||
          pair[0]!.accountId === pair[1]!.accountId ||
          pair.some(
            (r) =>
              r.splits?.length ||
              r.isoCurrency !== row.isoCurrency ||
              r.date !== row.date ||
              r.source !== "manual"
          ) ||
          money(pair[0]!.amountCents) + money(pair[1]!.amountCents) !== 0n
        )
          throw new Error("Repair unlinked card transfers before using payment reserves");
        state.paymentsCents = safeCents(money(state.paymentsCents) - money(row.amountCents));
        continue;
      }
      const parts = allocations(row);
      const debtParts = allocateCardCents(
        parts.map((p) => p.amountCents),
        safeCents(positive(after) - positive(before)),
        row.amountCents
      );
      for (let i = 0; i < parts.length; i++) {
        const id = parts[i]!.categoryId;
        if (id === null || id === "income" || id === "transfers") continue;
        contributions.push({
          accountId: row.accountId,
          categoryId: flex?.active && flex.flexIds.includes(id) ? FLEX_POOL : id,
          cents: money(debtParts[i]!)
        });
      }
    }
    const groups = new Map<string, Contribution[]>();
    for (const part of contributions) {
      const bucket = groups.get(part.categoryId) ?? [];
      bucket.push(part);
      groups.set(part.categoryId, bucket);
      if (part.cents < 0n) {
        const card = current.get(part.accountId)!;
        card.refundsCents = safeCents(money(card.refundsCents) + part.cents);
      }
    }
    for (const [id, parts] of groups) {
      const ordinary = input.ordinary[month]?.categories[id];
      const charges = parts.filter((p) => p.cents > 0n);
      const total = charges.reduce((sum, p) => sum + p.cents, 0n);
      const debt = parts.reduce((sum, p) => sum + p.cents, 0n);
      const refunds = debt - total;
      const activity = money(ordinary?.activityCents ?? 0);
      const budget = money(ordinary?.availableCents ?? 0) + activity;
      const capacity = positive(budget - (activity - debt) - refunds);
      const funded = capacity > total ? total : capacity;
      // This total may exceed safe cents during cancellation-heavy splits. Keep products BigInt.
      const apportioned = charges.map((p) => (total ? (p.cents * funded) / total : 0n));
      let remainder = funded - apportioned.reduce((sum, p) => sum + p, 0n);
      const order = charges
        .map((p, i) => ({ i, r: total ? (p.cents * funded) % total : 0n }))
        .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
      for (const { i } of order)
        if (remainder > 0n) {
          apportioned[i]! += 1n;
          remainder--;
        }
      for (let i = 0; i < charges.length; i++) {
        const card = current.get(charges[i]!.accountId)!;
        card.fundedCents = safeCents(money(card.fundedCents) + apportioned[i]!);
        card.unfundedCents = safeCents(
          money(card.unfundedCents) + charges[i]!.cents - apportioned[i]!
        );
      }
    }
    for (const card of current.values()) {
      card.owedCents = safeCents(positive(balances.get(card.accountId)!));
      card.assignedCents = safeCents(
        input.assignments
          .filter((a) => a.accountId === card.accountId && a.month === month)
          .reduce((sum, a) => sum + money(a.assignedCents), 0n)
      );
      card.availableCents = safeCents(
        (carry.get(card.accountId) ?? 0n) +
          money(card.assignedCents) +
          money(card.fundedCents) +
          money(card.refundsCents) -
          money(card.paymentsCents)
      );
      carry.set(card.accountId, positive(money(card.availableCents)));
    }
    result[month] = [...current.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));
  }
  return result;
}

/** Conservation: Ready + signed envelopes + signed reserves + unfunded credit = funding. */
export function cardReadyToAssignCents(
  accounts: readonly (BalanceLike & { accountId: string })[],
  ordinary: BudgetMonthStateCore,
  cards: readonly CardPaymentState[],
  futureReservedCents = 0
): number {
  const selected = new Set(cards.map((c) => c.accountId));
  let ready = -money(futureReservedCents);
  for (const account of accounts)
    if (countsTowardReady(account.type, account.subtype)) {
      const signed = money(signedBalanceCents(account));
      ready += selected.has(account.accountId) ? positive(signed) : signed;
    }
  for (const [id, category] of Object.entries(ordinary.categories))
    if (id !== "income" && id !== "transfers") ready -= money(category.availableCents);
  for (const card of cards) ready -= money(card.availableCents) + money(card.unfundedCents);
  return safeCents(ready);
}
