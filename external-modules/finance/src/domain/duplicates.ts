import type { TransactionRecord } from "./records.js";

/** Conservative candidates only. Identical legitimate purchases remain in the ledger. */
export function duplicateCandidates(rows: readonly TransactionRecord[]): Set<string> {
  const groups = new Map<string, TransactionRecord[]>();
  for (const row of rows) {
    const payee = (row.merchant ?? row.name).trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
    if (!payee || row.amountCents === 0) continue;
    const key = JSON.stringify([row.accountId, row.isoCurrency, row.date, row.amountCents, payee]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const candidates = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) candidates.add(row.id);
  }
  return candidates;
}
