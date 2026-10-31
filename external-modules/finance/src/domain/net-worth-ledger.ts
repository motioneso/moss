import type { AccountRecord, SnapshotChunk } from "./records.js";
import type { ManualDailyMovement } from "./manual-ledger.js";
import { balanceSign } from "./account-sign.js";
import { isCalendarDate, safeCents } from "./values.js";
export class NetWorthHistoryError extends Error {}
export interface NetWorthCoverage {
  accountId: string;
  name: string;
  source: "ledger" | "snapshot";
  asOf: string | null;
  balanceCents: number | null;
  contributionCents: number | null;
  included: boolean;
  reason?:
    | "opening_missing"
    | "not_open"
    | "storage_update_required"
    | "no_snapshot"
    | "outside_period";
}
export function ledgerNetWorthInputs(
  accounts: readonly AccountRecord[],
  snapshots: Record<string, SnapshotChunk>,
  movements: readonly ManualDailyMovement[],
  today: string,
  window: readonly string[],
  manualSupported: boolean
) {
  if (!isCalendarDate(today)) throw new NetWorthHistoryError("Choose a valid net worth date");
  const byId = new Map(accounts.map((a) => [a.accountId, a]));
  const chunks: Record<string, SnapshotChunk> = {};
  const coverage: NetWorthCoverage[] = [];
  const put = (accountId: string, date: string, balance: number) => {
    const key = `${accountId}:${date.slice(0, 7)}`;
    (chunks[key] ??= { days: {} }).days[date] = balance;
  };
  // Provider history keeps its existing snapshot source; manual ledger history replaces, rather
  // than adds to, any legacy snapshot for that same account.
  for (const [key, chunk] of Object.entries(snapshots)) {
    const id = key.slice(0, key.lastIndexOf(":"));
    const account = byId.get(id);
    if (!account || account.source === "manual") continue;
    for (const [date, cents] of Object.entries(chunk.days)) {
      if (!isCalendarDate(date))
        throw new NetWorthHistoryError("A recorded balance has an invalid date");
      if (date <= today) put(id, date, safeCents(cents));
    }
  }
  let hasLedger = false;
  for (const account of accounts) {
    const manual = account.source === "manual";
    const item: NetWorthCoverage = {
      accountId: account.accountId,
      name: account.name,
      source: manual ? "ledger" : "snapshot",
      asOf: null,
      balanceCents: null,
      contributionCents: null,
      included: false
    };
    coverage.push(item);
    if (!manual) continue;
    if (
      !account.openingDate ||
      account.openingBalanceCents === undefined ||
      !isCalendarDate(account.openingDate)
    ) {
      item.reason = "opening_missing";
      continue;
    }
    if (account.openingDate > today) {
      item.reason = "not_open";
      continue;
    }
    if (!manualSupported) {
      item.reason = "storage_update_required";
      continue;
    }
    const events = new Map<string, bigint>([[account.openingDate, 0n]]);
    for (const movement of movements.filter((m) => m.accountId === account.accountId)) {
      if (!isCalendarDate(movement.date))
        throw new NetWorthHistoryError("A manual ledger movement has an invalid date");
      if (movement.date > today) continue;
      if (
        !movement.valid ||
        movement.date < account.openingDate ||
        !/^-?\d+$/.test(movement.amountCents)
      )
        throw new NetWorthHistoryError(
          "Manual ledger data does not match its opening baseline and currency"
        );
      events.set(movement.date, (events.get(movement.date) ?? 0n) + BigInt(movement.amountCents));
    }
    let balance = BigInt(safeCents(account.openingBalanceCents));
    for (const [date, amount] of [...events].sort(([a], [b]) => a.localeCompare(b))) {
      balance -= BigInt(balanceSign(account.type)) * amount;
      put(account.accountId, date, safeCents(balance));
    }
    item.asOf = today;
    hasLedger = true;
  }
  // These are reference days for reconstructed ledger balances and existing snapshot carry,
  // not newly observed bank balances. The reducer admits them only after a known baseline.
  return {
    chunks,
    coverage,
    referenceDays: hasLedger && window[0] ? [`${window[0]}-01`, today] : []
  };
}
export function netWorthCoverage(
  inputs: ReturnType<typeof ledgerNetWorthInputs>,
  accounts: readonly AccountRecord[],
  headlineDate: string | null
) {
  return inputs.coverage.map((item) => {
    if (item.reason) return item;
    const account = accounts.find((a) => a.accountId === item.accountId)!;
    let last: string | null = null,
      balance: number | null = null;
    for (const [key, chunk] of Object.entries(inputs.chunks)) {
      if (key.slice(0, key.lastIndexOf(":")) !== item.accountId) continue;
      for (const [date, cents] of Object.entries(chunk.days))
        if ((headlineDate === null || date <= headlineDate) && (!last || date > last)) {
          last = date;
          balance = cents;
        }
    }
    if (last === null || balance === null) return { ...item, reason: "no_snapshot" as const };
    return {
      ...item,
      asOf: item.source === "ledger" ? item.asOf : last,
      balanceCents: balance,
      contributionCents: headlineDate
        ? safeCents(BigInt(balance) * BigInt(balanceSign(account.type)))
        : null,
      included: headlineDate !== null,
      ...(headlineDate === null ? { reason: "outside_period" as const } : {})
    };
  });
}
