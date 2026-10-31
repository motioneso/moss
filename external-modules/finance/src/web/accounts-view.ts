// external-modules/finance/src/web/accounts-view.ts
// #3177: pure view model for the Accounts screen. Takes the rows of
// finance.accounts.list and returns banks with a status line, a stale-bank
// as-of date, the net worth total, and the same accounts grouped by kind.
// No React, no I/O.

import { signedBalanceCents } from "../domain/account-sign.js";
import { safeCents } from "../domain/values.js";

export interface AccountsRow {
  accountId: string;
  itemId: string | null;
  source?: "manual" | "provider";
  openingDate?: string;
  archivedAt?: string | null;
  name: string;
  mask: string | null;
  type: string;
  subtype?: string | null;
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
  isoCurrency: string;
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

export type AccountKind = "cash" | "investment" | "credit" | "loan" | "other";

export interface AccountGroupRow extends AccountsLine {
  manual: boolean;
  /** "Manual", or the bank name with its sync state or as-of date. */
  source: string;
}

export interface CurrencyTotal {
  currency: string;
  /** Null means the exact sum exceeds safe display precision. */
  cents: number | null;
}

export interface AccountGroup {
  kind: AccountKind;
  title: string;
  totals: CurrencyTotal[];
  rows: AccountGroupRow[];
}

export interface AccountsView {
  banks: BankSection[];
  /** Assets first, debts last, so the page reads like a balance sheet. */
  groups: AccountGroup[];
  /** No cross-currency total. Null means the exact sum exceeds safe display precision. */
  netWorthByCurrency: Array<{ currency: string; netWorthCents: number | null }>;
  /** Debts are a positive amount owed. Same order as the net worth totals. */
  sidesByCurrency: Array<{
    currency: string;
    assetsCents: number | null;
    debtsCents: number | null;
  }>;
}

const KINDS: ReadonlyArray<{ kind: AccountKind; title: string }> = [
  { kind: "cash", title: "Cash" },
  { kind: "investment", title: "Investments" },
  { kind: "credit", title: "Credit cards" },
  { kind: "loan", title: "Loans" },
  { kind: "other", title: "Other" }
];

/** Checking, savings and cash on hand count as cash, the same rule ready to assign uses. */
export function accountKind(type: string, subtype: string | null | undefined): AccountKind {
  if (type === "depository" || (type === "other" && subtype === "cash")) return "cash";
  if (type === "investment" || type === "credit" || type === "loan") return type;
  return "other";
}

function addTo(totals: Map<string, bigint>, currency: string, cents: number): void {
  totals.set(currency, (totals.get(currency) ?? 0n) + BigInt(cents));
}

function safeTotal(total: bigint | undefined): number | null {
  const value = Number(total ?? 0n);
  return Number.isSafeInteger(value) ? value : null;
}

function currencyTotals(totals: Map<string, bigint>): CurrencyTotal[] {
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, cents: safeTotal(total) }));
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
    const key =
      account.source === "manual" ? "manual-account-group" : (account.itemId ?? "missing-item");
    const list = byItem.get(key) ?? [];
    list.push(account);
    byItem.set(key, list);
  }
  const bankFor = new Map(banks.map((bank) => [bank.itemId, bank]));
  // Keep the host's bank order, then any account whose bank record is missing.
  const itemIds = [
    ...banks.map((b) => b.itemId),
    ...[...byItem.keys()].filter((id) => !bankFor.has(id))
  ].filter((id) => byItem.has(id));

  const totals = new Map<string, bigint>();
  const assets = new Map<string, bigint>();
  const debts = new Map<string, bigint>();
  const sections: BankSection[] = itemIds.map((itemId, index) => {
    const bank = bankFor.get(itemId);
    const lines = (byItem.get(itemId) ?? []).map((account) => {
      const balanceCents = safeCents(signedBalanceCents(account));
      addTo(totals, account.isoCurrency, balanceCents);
      if (balanceCents < 0) addTo(debts, account.isoCurrency, -balanceCents);
      else addTo(assets, account.isoCurrency, balanceCents);
      return {
        accountId: account.accountId,
        name: account.name,
        mask: account.mask,
        balanceCents,
        isoCurrency: account.isoCurrency
      };
    });
    if (itemId === "manual-account-group")
      return {
        itemId,
        name: "Manual accounts",
        status: "ready",
        statusLabel: "Recorded in Moss",
        asOf: null,
        message: null,
        reconnect: false,
        accounts: lines
      };
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

  const kindOf = new Map(
    accounts.map((account) => [account.accountId, accountKind(account.type, account.subtype)])
  );
  const groups = KINDS.map(({ kind, title }) => {
    const groupTotals = new Map<string, bigint>();
    const rows: AccountGroupRow[] = [];
    for (const section of sections) {
      const manual = section.itemId === "manual-account-group";
      const state = section.asOf ? `As of ${section.asOf}` : section.statusLabel;
      for (const line of section.accounts) {
        if (kindOf.get(line.accountId) !== kind) continue;
        addTo(groupTotals, line.isoCurrency, line.balanceCents);
        rows.push({ ...line, manual, source: manual ? "Manual" : `${section.name} · ${state}` });
      }
    }
    return { kind, title, totals: currencyTotals(groupTotals), rows };
  }).filter((group) => group.rows.length > 0);

  return {
    banks: sections,
    groups,
    netWorthByCurrency: currencyTotals(totals).map(({ currency, cents }) => ({
      currency,
      netWorthCents: cents
    })),
    sidesByCurrency: currencyTotals(totals).map(({ currency }) => ({
      currency,
      assetsCents: safeTotal(assets.get(currency)),
      debtsCents: safeTotal(debts.get(currency))
    }))
  };
}
