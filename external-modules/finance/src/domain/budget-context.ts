import type { AccountRecord, TransactionRecord } from "./records.js";
import type { Category } from "./taxonomy.js";
import type { FinanceStore } from "./store-port.js";
import { countsTowardReady } from "./ready-to-assign.js";
import { balanceSign } from "./account-sign.js";
import { safeCents } from "./values.js";

export interface BudgetReview {
  revision: number;
  fingerprint: string;
}
export interface BudgetPolicy extends BudgetReview {
  isoCurrency: string;
  createdAt: string;
  taxonomyReady: boolean;
}
export interface BudgetPolicyStore {
  get(): Promise<BudgetPolicy | null>;
  categories(): Promise<Category[] | null>;
  initializeCategories(categories: readonly Category[], at: string): Promise<boolean>;
  configure(
    isoCurrency: string,
    acknowledgeLegacy: boolean,
    at: string,
    categories?: readonly Category[]
  ): Promise<"created" | "unchanged" | "conflict" | "legacy_review_required">;
}
export const budgetAccount = (account: AccountRecord, currency: string): boolean =>
  account.isoCurrency === currency && countsTowardReady(account.type, account.subtype);

/** Account scope applies before transfer inference; tracking activity never enters envelopes. */
export function budgetRows(
  accounts: AccountRecord[],
  currency: string,
  rows: TransactionRecord[],
  through: string
): TransactionRecord[] {
  const ids = new Set(
    accounts
      .filter((account) => budgetAccount(account, currency))
      .map((account) => account.accountId)
  );
  return rows.filter(
    (row) =>
      ids.has(row.accountId) && row.isoCurrency === currency && !row.pending && row.date <= through
  );
}
export interface FundingAccount {
  accountId: string;
  name: string;
  balanceCents: number | null;
  type: string;
  subtype: string | null;
  isoCurrency: string;
  asOf: string | null;
}
/** Manual history is reconstructed from its baseline, never today's mutable balance. */
export async function fundingAt(
  store: FinanceStore,
  accounts: AccountRecord[],
  rows: TransactionRecord[],
  month: string,
  currentDate: string
): Promise<FundingAccount[]> {
  const currentMonth = currentDate.slice(0, 7);
  const [year, number] = month.split("-").map(Number);
  const days =
    number === 2
      ? (year! % 4 === 0 && year! % 100 !== 0) || year! % 400 === 0
        ? 29
        : 28
      : [4, 6, 9, 11].includes(number!)
        ? 30
        : 31;
  const cutoff = month === currentMonth ? currentDate : `${month}-${days}`;
  const snapshots = month < currentMonth ? await store.listSnapshotChunks() : [];
  const result: FundingAccount[] = [];
  for (const account of accounts) {
    if (account.source === "manual" && account.openingDate && account.openingDate > cutoff)
      continue;
    let balance: number | null = null;
    let asOf: string | null = null;
    if (month === currentMonth) {
      balance = safeCents(account.balanceCents);
      asOf = account.updatedAt;
    } else if (
      month < currentMonth &&
      account.source === "manual" &&
      account.openingDate &&
      account.openingBalanceCents !== undefined
    ) {
      const movement = rows
        .filter((row) => row.accountId === account.accountId && !row.pending && row.date <= cutoff)
        .reduce((sum, row) => sum + BigInt(safeCents(row.amountCents)), 0n);
      balance = safeCents(
        BigInt(safeCents(account.openingBalanceCents)) -
          BigInt(balanceSign(account.type)) * movement
      );
      asOf = cutoff;
    } else if (month < currentMonth) {
      for (const chunk of snapshots.filter(
        (chunk) => chunk.accountId === account.accountId && chunk.month <= month
      )) {
        for (const [day, cents] of Object.entries(
          (await store.getSnapshotChunk(account.accountId, chunk.month)) ?? {}
        )) {
          if (day <= cutoff && (asOf === null || day > asOf)) {
            balance = safeCents(cents);
            asOf = day;
          }
        }
      }
    }
    result.push({
      accountId: account.accountId,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      isoCurrency: account.isoCurrency,
      balanceCents: balance,
      asOf
    });
  }
  return result;
}
