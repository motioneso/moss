// external-modules/finance/src/web/accounts-view.ts
// #3177: pure view model for the Accounts screen. Takes the rows of
// finance.accounts.list and returns banks with a status line, a stale-bank
// as-of date and the net worth total. No React, no I/O.

import { signedBalanceCents } from "../domain/account-sign.js";

export interface AccountsRow {
  accountId: string;
  itemId: string;
  name: string;
  mask: string | null;
  type: string;
  balanceCents: number;
  isoCurrency: string;
}

export interface AccountsBank {
  itemId: string;
  institutionId: string | null;
  institutionName?: string | null;
  status: "connected" | "reauth-required" | "error";
  lastSyncAt: string | null;
  message: string | null;
}

export interface AccountsLine {
  accountId: string;
  name: string;
  mask: string | null;
  /** Debts (credit, loan) are negative. */
  balanceCents: number;
}

export interface BankSection {
  itemId: string;
  name: string;
  status: "ready" | "error";
  statusLabel: string;
  /** Date balances are current to, set only when the bank cannot sync. */
  asOf: string | null;
  /** The stored provider message from the last failure. */
  message: string | null;
  reconnect: boolean;
  accounts: AccountsLine[];
}

export interface AccountsView {
  banks: BankSection[];
  netWorthCents: number;
  currency: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "Synced 2 hours ago" for the sync status line. */
export function syncedAgo(lastSyncAt: string | null, now: Date): string {
  if (!lastSyncAt) return "Not synced yet";
  const elapsed = now.getTime() - new Date(lastSyncAt).getTime();
  if (Number.isNaN(elapsed)) return "Not synced yet";
  if (elapsed < MINUTE_MS) return "Synced just now";
  if (elapsed < HOUR_MS) return `Synced ${plural(Math.floor(elapsed / MINUTE_MS), "minute")} ago`;
  if (elapsed < DAY_MS) return `Synced ${plural(Math.floor(elapsed / HOUR_MS), "hour")} ago`;
  return `Synced ${plural(Math.floor(elapsed / DAY_MS), "day")} ago`;
}

function asOfDate(lastSyncAt: string | null): string | null {
  if (!lastSyncAt) return null;
  const parsed = new Date(lastSyncAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

export function buildAccountsView(
  accounts: readonly AccountsRow[],
  banks: readonly AccountsBank[],
  now: Date
): AccountsView {
  const byItem = new Map<string, AccountsRow[]>();
  for (const account of accounts) {
    const list = byItem.get(account.itemId) ?? [];
    list.push(account);
    byItem.set(account.itemId, list);
  }
  const bankFor = new Map(banks.map((bank) => [bank.itemId, bank]));
  // Keep the host's bank order, then any account whose bank record is missing.
  const itemIds = [
    ...banks.map((b) => b.itemId),
    ...[...byItem.keys()].filter((id) => !bankFor.has(id))
  ].filter((id) => byItem.has(id));

  let netWorthCents = 0;
  const sections: BankSection[] = itemIds.map((itemId, index) => {
    const bank = bankFor.get(itemId);
    const lines = (byItem.get(itemId) ?? []).map((account) => {
      const balanceCents = signedBalanceCents(account);
      netWorthCents += balanceCents;
      return {
        accountId: account.accountId,
        name: account.name,
        mask: account.mask,
        balanceCents
      };
    });
    const status = bank?.status ?? "error";
    const known = bank?.institutionName?.trim();
    const name = known ? known : itemIds.length === 1 ? "Connected bank" : `Bank ${index + 1}`;
    if (status === "connected") {
      return {
        itemId,
        name,
        status: "ready",
        statusLabel: syncedAgo(bank?.lastSyncAt ?? null, now),
        asOf: null,
        message: null,
        reconnect: false,
        accounts: lines
      };
    }
    return {
      itemId,
      name,
      status: "error",
      statusLabel: status === "reauth-required" ? "Sign-in expired" : "Connection problem",
      asOf: asOfDate(bank?.lastSyncAt ?? null),
      message: bank?.message ?? null,
      reconnect: status === "reauth-required",
      accounts: lines
    };
  });

  return {
    banks: sections,
    netWorthCents,
    currency: accounts[0]?.isoCurrency ?? "USD"
  };
}
