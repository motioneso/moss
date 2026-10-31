import type { TransactionChunk, TransactionRecord } from "../../domain/index.js";
import { monthWindow, parseSharedKey, toSharedTransaction } from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import { readActiveUserIds, readInt, readString } from "../validate.js";
import { today } from "./manual-ledger.js";
export function readWindow(input: Record<string, unknown>, ports: WorkerPorts): string[] {
  const months = readInt(input, "months", { min: 1, max: 24 }) ?? 6;
  // Report months belong to the authenticated owner's calendar, including UTC month boundaries.
  // Older read-only hosts did not supply locale; retain their UTC report behavior.
  const date = ports.localTimezone ? today(ports) : ports.now().toISOString().slice(0, 10);
  return monthWindow(new Date(`${date}T12:00:00Z`), months);
}
function loadMonths(window: string[]): Set<string> {
  const [first = ""] = window;
  const [year = 0, month = 1] = first.split("-").map(Number);
  return new Set([new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7), ...window]);
}
export async function loadReportRows(ports: WorkerPorts, input: Record<string, unknown>) {
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

  return { window, own, sharedByOwner, actorUserId };
}
