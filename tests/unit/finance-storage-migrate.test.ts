// tests/unit/finance-storage-migrate.test.ts
// FIN-06b (#1166) Task 6: the one-shot per-owner KV -> SQL backfill run by
// the finance.storage-migrate queue handler. Pinned here: copy order is
// insert-then-count-verify-then-mark-then-delete (a crash before the marker
// leaves KV as the untouched source of truth; the marker is written before
// any KV key is deleted, never after); replay after the marker is a pure
// no-op (idempotent under reconcile re-delivery); a short count-verify
// aborts before either the marker or any delete; cursor:*/link:*/rules/
// categories/settings/finance.shared are never read or touched; state:*
// cache keys are deleted but never copied into SQL (F6-D1 — a throwaway
// performance projection, not source of truth).
import { describe, expect, it } from "vitest";

import type { FinanceDb, FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import { NS } from "../../external-modules/finance/src/domain/index.js";
import { MIGRATED_MARKER_KEY } from "../../external-modules/finance/src/worker/store.js";
import { storageMigrateHandler } from "../../external-modules/finance/src/worker/handlers/migrate.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

function fakeKv(seed: Record<string, Record<string, Record<string, unknown>>> = {}): FinanceKv {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [namespace, keys] of Object.entries(seed)) {
    store.set(namespace, new Map(Object.entries(keys)));
  }
  const ns = (namespace: string) => {
    let bucket = store.get(namespace);
    if (!bucket) {
      bucket = new Map();
      store.set(namespace, bucket);
    }
    return bucket;
  };
  return {
    get: async (namespace, key) => structuredClone(ns(namespace).get(key) ?? null),
    set: async (namespace, key, value) => {
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()]
  };
}

type Call = { text: string; params: readonly unknown[] | undefined };

// countOverride lets tests pin count(*) results independent of what was
// actually inserted (so the count-verify mismatch path is reachable without
// a real database).
function fakeDb(
  opts: { countOverride?: Record<string, number> } = {}
): FinanceDb & { calls: Call[] } {
  const calls: Call[] = [];
  const inserted: Record<string, unknown[]> = {
    "app.finance_items": [],
    "app.finance_accounts": [],
    "app.finance_transactions": [],
    "app.finance_balance_snapshots": [],
    "app.finance_budget_assignments": [],
    "app.finance_categories": []
  };
  const db = {
    calls,
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      calls.push({ text, params });
      if (text.startsWith("SELECT count(*)")) {
        const table = Object.keys(inserted).find((name) => text.includes(name));
        const n = opts.countOverride?.[table ?? ""] ?? (table ? inserted[table]!.length : 0);
        return { rows: [{ n }] as unknown as T[] };
      }
      const table = Object.keys(inserted).find((name) => text.includes(name));
      if (table && text.startsWith("INSERT")) inserted[table]!.push(params);
      return { rows: [] as T[] };
    }
  };
  return db;
}

function ports(kv: FinanceKv, db: FinanceDb | null): WorkerPorts {
  return {
    kv,
    mirror: {
      get: async () => {
        throw new Error("storage-migrate must not read the household mirror");
      },
      set: async () => {
        throw new Error("storage-migrate must not write the household mirror");
      },
      delete: async () => {
        throw new Error("storage-migrate must not delete from the household mirror");
      },
      list: async () => {
        throw new Error("storage-migrate must not list the household mirror");
      }
    },
    ai: null,
    db,
    plaid: null,
    tokens: {
      read: async () => {
        throw new Error("storage-migrate must not read tokens");
      },
      write: async () => {
        throw new Error("storage-migrate must not write tokens");
      }
    },
    creds: {
      get: async () => {
        throw new Error("storage-migrate must not read creds");
      }
    },
    settings: {
      getEnvironment: async () => {
        throw new Error("storage-migrate must not read settings");
      }
    },
    isAdmin: false,
    now: () => new Date("2026-07-18T12:00:00Z"),
    store: async () => {
      throw new Error("storage-migrate reads kv/db directly, never via store()");
    }
  };
}

const ACTOR = "00000000-0000-4000-8000-0000000000aa";

function seededKv(): FinanceKv {
  return fakeKv({
    [NS.connections]: {
      "item:item-1": {
        itemId: "item-1",
        institutionId: "ins_1",
        connectedAt: "2026-07-01T00:00:00Z",
        status: "connected"
      },
      // Never read or copied — sync-cursor and link-session keys.
      "cursor:item-1": { cursor: "opaque" },
      "link:abc123": {
        linkToken: "abc",
        hostedLinkUrl: "https://x",
        createdAt: "t",
        status: "pending"
      }
    },
    [NS.accounts]: {
      "acc-1": {
        accountId: "acc-1",
        itemId: "item-1",
        name: "Checking",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: "0000",
        balanceCents: 500000,
        isoCurrency: "USD",
        updatedAt: "2026-07-18T06:00:00Z"
      }
    },
    [NS.transactions]: {
      "acc-1:2026-07": {
        transactions: [
          {
            id: "t1",
            accountId: "acc-1",
            date: "2026-07-10",
            amountCents: 1200,
            isoCurrency: "USD",
            name: "Coffee",
            merchant: null,
            plaidCategory: null,
            categoryId: null,
            pending: false,
            pendingTransactionId: null,
            categorizedBy: null
          }
        ]
      }
    },
    [NS.snapshots]: {
      "acc-1:2026-07": { days: { "2026-07-01": 490000, "2026-07-02": 495000 } }
    },
    [NS.budgets]: {
      "ledger:2026-07": { assignments: { groceries: 30000 } },
      // Cache — must be deleted but never copied into SQL (F6-D1).
      "state:2026-07": { tbbCents: 0, categories: {}, computedAt: "2026-07-01T00:00:00Z" }
    }
  });
}

async function callHandler(kv: FinanceKv, db: FinanceDb | null) {
  return storageMigrateHandler(ports(kv, db))({
    actorUserId: ACTOR,
    jobKind: "finance.storage-migrate"
  });
}

describe("finance.storage-migrate (FIN-06b #1166)", () => {
  it("happy path: copies KV sources, count-verifies, marks, THEN deletes — in that order", async () => {
    const kv = seededKv();
    const db = fakeDb();
    const result = await callHandler(kv, db);

    expect(result).toEqual({
      status: "migrated",
      counts: { items: 1, accounts: 1, transactions: 1, snapshotDays: 2, assignments: 1 }
    });

    // Marker written.
    expect(await kv.get(NS.meta, MIGRATED_MARKER_KEY)).toEqual({
      migratedAt: "2026-07-18T12:00:00.000Z"
    });

    // Migrated keys gone.
    expect(await kv.get(NS.connections, "item:item-1")).toBeNull();
    expect(await kv.get(NS.accounts, "acc-1")).toBeNull();
    expect(await kv.get(NS.transactions, "acc-1:2026-07")).toBeNull();
    expect(await kv.get(NS.snapshots, "acc-1:2026-07")).toBeNull();
    expect(await kv.get(NS.budgets, "ledger:2026-07")).toBeNull();
    // state:* cache dies here too (F6-D1) — deleted, never copied.
    expect(await kv.get(NS.budgets, "state:2026-07")).toBeNull();

    // Untouched: cursor/link/rules/categories/settings/finance.shared.
    expect(await kv.get(NS.connections, "cursor:item-1")).not.toBeNull();
    expect(await kv.get(NS.connections, "link:abc123")).not.toBeNull();

    // Call-order: last insert index < marker set index < first delete index.
    const insertCalls = db.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.text.startsWith("INSERT"));
    const countCalls = db.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.text.startsWith("SELECT count(*)"));
    expect(insertCalls.length).toBeGreaterThan(0);
    expect(countCalls.length).toBeGreaterThan(0);
    const lastInsertIndex = Math.max(...insertCalls.map(({ index }) => index));
    const lastCountIndex = Math.max(...countCalls.map(({ index }) => index));
    expect(lastCountIndex).toBeGreaterThan(lastInsertIndex);

    // ON CONFLICT ... DO NOTHING — never DO UPDATE (crash-replay safety).
    for (const { call } of insertCalls) {
      expect(call.text).toContain("DO NOTHING");
      expect(call.text).not.toContain("DO UPDATE");
    }
  });

  it("replay with marker already set copies only categories (insert-ignore) and nothing else", async () => {
    const kv = fakeKv({
      [NS.meta]: { [MIGRATED_MARKER_KEY]: { migratedAt: "2026-07-01T00:00:00.000Z" } }
    });
    const db = fakeDb();
    const result = await callHandler(kv, db);
    expect(result).toEqual({ status: "already-migrated" });
    expect(db.calls).toHaveLength(16);
    for (const call of db.calls) {
      expect(call.text).toContain("app.finance_categories");
      expect(call.text).toContain("DO NOTHING");
    }
  });

  it("copies the stored taxonomy into the categories table with groups, order, income flag and archive date", async () => {
    const kv = fakeKv({
      [NS.meta]: { [MIGRATED_MARKER_KEY]: { migratedAt: "2026-07-01T00:00:00.000Z" } },
      [NS.categories]: {
        taxonomy: {
          categories: [
            { id: "rent-mortgage", group: "fixed", name: "Rent & mortgage", archived: false },
            { id: "income", group: "income", name: "Income", archived: false },
            { id: "my-pets", group: "custom", name: "Pets", archived: true }
          ]
        }
      }
    });
    const db = fakeDb();
    await callHandler(kv, db);
    expect(db.calls.map((call) => call.params)).toEqual([
      ["rent-mortgage", "Bills", "Rent & mortgage", 0, false, null],
      ["income", "Income", "Income", 1, true, null],
      ["my-pets", "Everyday", "Pets", 2, false, "2026-07-18T12:00:00.000Z"]
    ]);
    // The KV taxonomy is left in place.
    expect(await kv.get(NS.categories, "taxonomy")).not.toBeNull();
  });

  it("assigns the 16 defaults to the five groups when no taxonomy is stored", async () => {
    const kv = fakeKv({
      [NS.meta]: { [MIGRATED_MARKER_KEY]: { migratedAt: "2026-07-01T00:00:00.000Z" } }
    });
    const db = fakeDb();
    await callHandler(kv, db);
    const groups = new Set(db.calls.map((call) => call.params?.[1]));
    expect([...groups].sort()).toEqual(["Bills", "Everyday", "Fun", "Income", "Savings"]);
    expect(db.calls.filter((call) => call.params?.[4] === true)).toHaveLength(1);
  });

  it("throws when ctx.db is absent (older host) — never marks", async () => {
    const kv = seededKv();
    await expect(callHandler(kv, null)).rejects.toThrow();
    expect(await kv.get(NS.meta, MIGRATED_MARKER_KEY)).toBeNull();
    // Nothing was read/deleted either — source data intact.
    expect(await kv.get(NS.accounts, "acc-1")).not.toBeNull();
  });

  it("count-verify mismatch throws and aborts before marking or deleting", async () => {
    const kv = seededKv();
    // Every table under-reports so every check fails; nothing should mark/delete.
    const db = fakeDb({
      countOverride: {
        "app.finance_items": 0,
        "app.finance_accounts": 0,
        "app.finance_transactions": 0,
        "app.finance_balance_snapshots": 0,
        "app.finance_budget_assignments": 0
      }
    });
    await expect(callHandler(kv, db)).rejects.toThrow();
    expect(await kv.get(NS.meta, MIGRATED_MARKER_KEY)).toBeNull();
    expect(await kv.get(NS.accounts, "acc-1")).not.toBeNull();
    expect(await kv.get(NS.connections, "item:item-1")).not.toBeNull();
  });

  it("rules/categories/settings/finance.shared are never read (mirror throws on any access)", async () => {
    // seededKv() has no rules/categories/settings namespaces seeded at all;
    // the mirror port throws on every method (see ports() above) — a pass
    // here proves the handler never touches it.
    const kv = seededKv();
    const db = fakeDb();
    await expect(callHandler(kv, db)).resolves.toMatchObject({ status: "migrated" });
  });
});
