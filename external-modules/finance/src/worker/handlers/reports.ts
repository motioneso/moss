// external-modules/finance/src/worker/handlers/reports.ts
//
// FIN-05 (#1150): the two report tools (spec delta §"Manifest delta"). Both
// are risk "read" — pure aggregation, no KV writes (the host rejects
// mutation from read tools with forbidden_kv_mutation, which is exactly the
// posture reports want). Windows come from ports.now(); never ambient time.
import type { SnapshotChunk, TransactionChunk, TransactionRecord } from "../../domain/index.js";
import {
  aggregateSpending,
  deriveNetWorth,
  excludeTransfers,
  monthWindow,
  parseSharedKey,
  toSharedTransaction
} from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { readActiveUserIds, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

function readWindow(input: Record<string, unknown>, ports: WorkerPorts): string[] {
  const months = readInt(input, "months", { min: 1, max: 24 }) ?? 6;
  return monthWindow(ports.now(), months);
}

/** Window months plus ONE margin month before the window: pairs straddle
 *  month boundaries (out-leg Jan 31, in-leg Feb 1), so pairing must see the
 *  month preceding the window even though aggregation never reports it. */
function loadMonths(window: string[]): Set<string> {
  const [first = ""] = window;
  const [year = 0, month = 1] = first.split("-").map(Number);
  const margin = new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
  return new Set([margin, ...window]);
}

export const reportsSpendingHandler: ToolFactory = (ports) => async (input) => {
  // Host-injected at the dispatch chokepoint (spread LAST) — never
  // caller-controlled (#1149).
  const actorUserId = readString(input, "actorUserId", { required: true });
  const activeUserIds = readActiveUserIds(input);
  const window = readWindow(input, ports);
  const months = loadMonths(window);

  // FIN-06c (#1166) Task 9: one store call per margin+window month.
  const store = await ports.store();
  const own: TransactionRecord[] = [];
  for (const month of months) {
    own.push(...(await store.listMonthTransactions(month)));
  }

  // Household rows grouped BY OWNER: pairing never crosses owners, and the
  // wire shape stays per-owner so the web can run the FIN-04 fail-closed
  // deleted-owner drop before merging (presentation merges, data doesn't).
  const sharedByOwner = new Map<string, TransactionRecord[]>();
  for (const key of await ports.mirror.list()) {
    const parsed = parseSharedKey(key);
    if (!parsed || !months.has(parsed.suffix)) continue;
    if (parsed.ownerUserId === actorUserId) continue;
    // Deleted/deactivated owners leave mirror residue; never surface it.
    if (!activeUserIds.has(parsed.ownerUserId)) continue;
    const chunk = (await ports.mirror.get(key)) as TransactionChunk | null;
    if (!chunk || !Array.isArray(chunk.transactions)) continue;
    let rows = sharedByOwner.get(parsed.ownerUserId);
    if (!rows) {
      rows = [];
      sharedByOwner.set(parsed.ownerUserId, rows);
    }
    for (const record of chunk.transactions) {
      // Re-apply the write-side allowlist on read (never trust mirror rows).
      rows.push(toSharedTransaction(record));
    }
  }

  return {
    window,
    own: aggregateSpending(excludeTransfers(own), window),
    shared: [...sharedByOwner.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ownerUserId, rows]) => ({
        ownerUserId,
        months: aggregateSpending(excludeTransfers(rows), window)
      })),
    // Taxonomy rides along so the screen renders category names from one
    // call (same shape transactions.query ships).
    categories: await loadCategories(ports)
  };
};

export const reportsNetWorthHandler: ToolFactory = (ports) => async (input) => {
  readString(input, "actorUserId", { required: true });
  const window = readWindow(input, ports);

  const store = await ports.store();
  const accounts = await store.listAccounts();
  // ALL snapshot chunks, not just window months: pre-window snapshots feed
  // carry-forward into the window (domain/net-worth.ts contract). Bounded by
  // accounts × months-since-connect. Own-only by design — snapshots are
  // never mirrored, so the mirror port is untouched here.
  const chunks: Record<string, SnapshotChunk> = {};
  for (const { accountId, month } of await store.listSnapshotChunks()) {
    const days = await store.getSnapshotChunk(accountId, month);
    if (days) chunks[`${accountId}:${month}`] = { days };
  }
  return { window, ...deriveNetWorth(accounts, chunks, window) };
};
