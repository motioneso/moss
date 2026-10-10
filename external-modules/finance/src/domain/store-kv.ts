// external-modules/finance/src/domain/store-kv.ts
// FIN-06 (#1166, F6-D3): FinanceStore backed by the existing FinanceKv —
// today's storage, wearing the port. Key/chunk shapes here are copied
// verbatim from the handlers that read/write them today (sync.ts, connect.ts,
// budget.ts) so this extraction changes nothing about what's on disk. The SQL
// implementation (Task 5, store-sql.ts) must produce byte-identical reads.
import type { FinanceKv } from "./kv-port.js";
import { NS } from "./kv-port.js";
import { monthKey } from "./keys.js";
import type { AccountRecord, ItemRecord, TransactionRecord } from "./records.js";
import type { BudgetLedger } from "./envelope.js";
import type { BudgetDraft } from "./draft.js";
import type { FinanceStore } from "./store-port.js";

// Same prefix connect.ts's loadItems() filters on — duplicated here (not
// imported) because domain files never depend on worker/handlers/* (layering
// convention: worker depends on domain, never the reverse).
const ITEM_PREFIX = "item:";
const LEDGER_PREFIX = "ledger:";
const DRAFT_KEY = "draft:first-budget";

function transactionChunkKey(accountId: string, month: string): string {
  return `${accountId}:${month}`;
}

/** Chunk sort contract: date DESC, then id ASC. sqlStore must match this. */
function sortTransactions(records: TransactionRecord[]): TransactionRecord[] {
  return [...records].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function kvStore(kv: FinanceKv): FinanceStore {
  return {
    async listItems() {
      const keys = await kv.list(NS.connections);
      const items: ItemRecord[] = [];
      for (const key of keys) {
        if (!key.startsWith(ITEM_PREFIX)) continue;
        const record = await kv.get(NS.connections, key);
        if (record) items.push(record as unknown as ItemRecord);
      }
      return items;
    },

    async getItem(itemId) {
      const record = await kv.get(NS.connections, `${ITEM_PREFIX}${itemId}`);
      return (record as unknown as ItemRecord | null) ?? null;
    },

    async putItem(record) {
      await kv.set(NS.connections, `${ITEM_PREFIX}${record.itemId}`, record);
    },

    async listAccounts() {
      const accountIds = await kv.list(NS.accounts);
      const accounts: AccountRecord[] = [];
      for (const accountId of accountIds) {
        const record = await kv.get(NS.accounts, accountId);
        if (record) accounts.push(record as unknown as AccountRecord);
      }
      return accounts;
    },

    async getAccount(accountId) {
      const record = await kv.get(NS.accounts, accountId);
      return (record as unknown as AccountRecord | null) ?? null;
    },

    async putAccount(record) {
      await kv.set(NS.accounts, record.accountId, record);
    },

    async listTransactionMonths() {
      const keys = await kv.list(NS.transactions);
      const months = new Set(
        keys.map((key) => key.split(":")[1]).filter((month): month is string => month !== undefined)
      );
      return [...months].sort().reverse();
    },

    async listMonthTransactions(month) {
      const keys = await kv.list(NS.transactions);
      const records: TransactionRecord[] = [];
      for (const key of keys) {
        if (key.split(":")[1] !== month) continue;
        const chunk = await kv.get(NS.transactions, key);
        if (chunk)
          records.push(...(chunk as unknown as { transactions: TransactionRecord[] }).transactions);
      }
      return sortTransactions(records);
    },

    async listConfirmedPayeeNames() {
      const names = new Set<string>();
      for (const key of await kv.list(NS.transactions)) {
        const chunk = await kv.get(NS.transactions, key);
        if (!chunk) continue;
        for (const record of (chunk as unknown as { transactions: TransactionRecord[] })
          .transactions) {
          if (record.categoryId !== null && (record.reviewState ?? "confirmed") === "confirmed") {
            names.add(record.name);
          }
        }
      }
      return [...names];
    },

    async getTransactionChunk(accountId, month) {
      const chunk = await kv.get(NS.transactions, transactionChunkKey(accountId, month));
      if (!chunk) return null;
      return sortTransactions(
        (chunk as unknown as { transactions: TransactionRecord[] }).transactions
      );
    },

    async putTransactionChunk(accountId, month, records) {
      await kv.set(NS.transactions, transactionChunkKey(accountId, month), {
        transactions: sortTransactions(records)
      });
    },

    async putTransaction(record) {
      const key = monthKey(record.accountId, record.date);
      const chunk = await kv.get(NS.transactions, key);
      const existing =
        (chunk as unknown as { transactions: TransactionRecord[] } | null)?.transactions ?? [];
      const next = existing.some((row) => row.id === record.id)
        ? existing.map((row) => (row.id === record.id ? record : row))
        : [...existing, record];
      await kv.set(NS.transactions, key, { transactions: sortTransactions(next) });
    },

    async listSnapshotChunks() {
      const keys = await kv.list(NS.snapshots);
      // "YYYY-MM" is a fixed 7 chars, so the last 8 chars of any chunk key
      // are always ":YYYY-MM" — slicing (not splitting) tolerates accountIds
      // that could themselves contain ":" (same idiom sync.ts uses today).
      return keys.map((key) => ({ accountId: key.slice(0, -8), month: key.slice(-7) }));
    },

    async getSnapshotChunk(accountId, month) {
      const chunk = await kv.get(NS.snapshots, transactionChunkKey(accountId, month));
      if (!chunk) return null;
      return (chunk as unknown as { days: Record<string, number> }).days;
    },

    async putSnapshotChunk(accountId, month, days) {
      await kv.set(NS.snapshots, transactionChunkKey(accountId, month), { days });
    },

    async listAssignmentMonths() {
      const keys = await kv.list(NS.budgets);
      const months = keys
        .filter((key) => key.startsWith(LEDGER_PREFIX))
        .map((key) => key.slice(LEDGER_PREFIX.length));
      return months.sort();
    },

    async getLedger(month) {
      const ledger = await kv.get(NS.budgets, `${LEDGER_PREFIX}${month}`);
      return (ledger as unknown as BudgetLedger | null) ?? null;
    },

    async setAssignment(month, categoryId, amountCents) {
      const key = `${LEDGER_PREFIX}${month}`;
      const ledger = ((await kv.get(NS.budgets, key)) as unknown as BudgetLedger | null) ?? {
        assignments: {}
      };
      ledger.assignments[categoryId] = amountCents;
      await kv.set(NS.budgets, key, ledger as unknown as Record<string, unknown>);
    },

    // The activity trail lives in SQL only; the KV store (migration source
    // and unit-test fake) keeps no trail.
    async appendActivity() {},

    async lastLoggedAssignment() {
      return null;
    },

    // One draft per owner, kept under the budgets namespace beside the ledgers.
    async getLatestDraft() {
      const stored = await kv.get(NS.budgets, DRAFT_KEY);
      const draft = (stored as unknown as BudgetDraft | null) ?? null;
      return draft && draft.status !== "discarded" ? draft : null;
    },

    async createDraft(build, createdAt) {
      const id = globalThis.crypto.randomUUID();
      const draft: BudgetDraft = {
        id,
        status: "open",
        basisFrom: build.basisFrom,
        basisTo: build.basisTo,
        monthlyIncomeCents: build.monthlyIncomeCents,
        createdAt,
        startedAt: null,
        lines: build.lines.map((line) => ({
          ...line,
          adjustedCents: null,
          adjustedBy: null,
          dropped: false
        }))
      };
      await kv.set(NS.budgets, DRAFT_KEY, draft as unknown as Record<string, unknown>);
      return id;
    },

    async markDraftStarted(draftId, startedAt) {
      const stored = (await kv.get(NS.budgets, DRAFT_KEY)) as unknown as BudgetDraft | null;
      if (!stored || stored.id !== draftId || stored.status !== "open") return;
      await kv.set(NS.budgets, DRAFT_KEY, {
        ...stored,
        status: "started",
        startedAt
      } as unknown as Record<string, unknown>);
    },

    async saveDraftLine(draftId, line) {
      const stored = (await kv.get(NS.budgets, DRAFT_KEY)) as unknown as BudgetDraft | null;
      if (!stored || stored.id !== draftId || stored.status !== "open") return;
      const exists = stored.lines.some((existing) => existing.categoryKey === line.categoryKey);
      const lines = exists
        ? stored.lines.map((existing) =>
            existing.categoryKey === line.categoryKey ? line : existing
          )
        : [...stored.lines, line];
      await kv.set(NS.budgets, DRAFT_KEY, { ...stored, lines } as unknown as Record<
        string,
        unknown
      >);
    }
  };
}
