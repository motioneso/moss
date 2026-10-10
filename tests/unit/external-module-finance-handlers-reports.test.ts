// tests/unit/external-module-finance-handlers-reports.test.ts
import { describe, expect, it } from "vitest";

import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type {
  FinanceKv,
  SharedMirrorKv,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  reportsNetWorthHandler,
  reportsSpendingHandler
} from "../../external-modules/finance/src/worker/handlers/reports.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// FIN-05 (#1150): the two report tools over scripted ports (spec delta
// §"Manifest delta"/"Household merge"). Pinned: window from ports.now()
// (months 1..24 default 6); spending merges the mirror per owner (own prefix
// skipped, allowlist re-applied, per-owner pairing) and returns shared
// contributions PER OWNER for the web's fail-closed drop; net worth reads
// snapshots + accounts only (mirror throws — own-only by design).

const NOW = new Date("2026-07-18T12:00:00Z");

function fakeKv(): FinanceKv {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
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

// reports.spending reads the household mirror for real — a Map-backed fake
// (fakeKv minus namespaces; SharedMirrorKv is keyed access to one namespace).
function fakeMirror(): SharedMirrorKv {
  const store = new Map<string, Record<string, unknown>>();
  return {
    get: async (key) => structuredClone(store.get(key) ?? null),
    set: async (key, value) => {
      store.set(key, structuredClone(value));
    },
    delete: async (key) => store.delete(key),
    list: async () => [...store.keys()]
  };
}

// net-worth stays own-only BY CONSTRUCTION: snapshots are never mirrored, so
// its ports get the FIN-03-style throwing mirror to prove it never looks.
function throwingMirror(): SharedMirrorKv {
  return {
    get: async () => {
      throw new Error("net-worth must not read the household mirror");
    },
    set: async () => {
      throw new Error("report handlers must not write the household mirror");
    },
    delete: async () => {
      throw new Error("report handlers must not delete from the household mirror");
    },
    list: async () => {
      throw new Error("net-worth must not list the household mirror");
    }
  };
}

// Reports are pure aggregation — touching Plaid creds, tokens, or instance
// settings throws, same isolation contract as the feed/budget handler tests.
function fakePorts(kv: FinanceKv, mirror: SharedMirrorKv): WorkerPorts {
  return {
    kv,
    mirror,
    ai: null,
    db: null,
    plaid: null,
    tokens: {
      read: async () => {
        throw new Error("report handlers must not read tokens");
      },
      write: async () => {
        throw new Error("report handlers must not write tokens");
      }
    },
    creds: {
      get: async () => {
        throw new Error("report handlers must not read creds");
      }
    },
    settings: {
      getEnvironment: async () => {
        throw new Error("report handlers must not read settings");
      }
    },
    isAdmin: false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => kvStore(kv)
  };
}

let txnSeq = 0;
function tx(over: Partial<TransactionRecord> & { amountCents: number }): TransactionRecord {
  txnSeq += 1;
  return {
    id: `tx-${txnSeq}`,
    accountId: "acc-1",
    date: "2026-07-10",
    isoCurrency: "USD",
    name: "ACME",
    merchant: null,
    plaidCategory: null,
    categoryId: null,
    pending: false,
    pendingTransactionId: null,
    categorizedBy: null,
    ...over
  };
}

describe("finance.reports.spending", () => {
  it("defaults to a 6-month window ending now and requires actorUserId", async () => {
    const kv = fakeKv();
    const ports = fakePorts(kv, fakeMirror());
    const result = (await reportsSpendingHandler(ports)({ actorUserId: "user-1" })) as {
      window: string[];
      own: Array<{ month: string }>;
      shared: unknown[];
    };
    expect(result.window).toEqual([
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07"
    ]);
    expect(result.own.map((m) => m.month)).toEqual(result.window);
    expect(result.shared).toEqual([]);
    await expect(reportsSpendingHandler(ports)({})).rejects.toThrow(/actorUserId/);
  });

  it("clamps months to 1..24", async () => {
    const ports = fakePorts(fakeKv(), fakeMirror());
    await expect(reportsSpendingHandler(ports)({ actorUserId: "u", months: 0 })).rejects.toThrow();
    await expect(reportsSpendingHandler(ports)({ actorUserId: "u", months: 25 })).rejects.toThrow();
    const one = (await reportsSpendingHandler(ports)({ actorUserId: "u", months: 1 })) as {
      window: string[];
    };
    expect(one.window).toEqual(["2026-07"]);
  });

  it("excludes the effective transfer set from own aggregation, pairing across months", async () => {
    const kv = fakeKv();
    // Out-leg June 30 categorized transfers; in-leg July 2 uncategorized —
    // pairing must remove BOTH even though June is outside the months=1
    // window (the handler loads one margin month before the window).
    await kv.set(NS.transactions, "checking:2026-06", {
      transactions: [
        tx({
          id: "out",
          accountId: "checking",
          date: "2026-06-30",
          amountCents: 50_000,
          categoryId: "transfers"
        })
      ]
    });
    await kv.set(NS.transactions, "savings:2026-07", {
      transactions: [
        tx({ id: "in", accountId: "savings", date: "2026-07-02", amountCents: -50_000 }),
        tx({ id: "coffee", accountId: "savings", date: "2026-07-05", amountCents: 675 })
      ]
    });
    const ports = fakePorts(kv, fakeMirror());
    const result = (await reportsSpendingHandler(ports)({ actorUserId: "u", months: 1 })) as {
      own: Array<{ byCategory: Record<string, number> }>;
    };
    expect(result.own[0]!.byCategory).toEqual({ uncategorized: 675 });
  });

  it("merges shared owners per-owner with the allowlist re-applied and own prefix skipped", async () => {
    const kv = fakeKv();
    const mirror = fakeMirror();
    await mirror.set("u:acc-own:2026-07", {
      transactions: [
        tx({ id: "own-mirrored", accountId: "acc-own", amountCents: 111, categoryId: "groceries" })
      ]
    });
    await mirror.set("other:acc-x:2026-07", {
      transactions: [
        {
          ...tx({
            id: "shared-1",
            accountId: "acc-x",
            amountCents: 2_000,
            categoryId: "groceries"
          }),
          notes: "MUST NOT SURVIVE THE ALLOWLIST"
        }
      ]
    });
    const ports = fakePorts(kv, mirror);
    const result = (await reportsSpendingHandler(ports)({
      actorUserId: "u",
      activeUserIds: ["u", "other"],
      months: 1
    })) as {
      own: Array<{ byCategory: Record<string, number> }>;
      shared: Array<{
        ownerUserId: string;
        months: Array<{ byCategory: Record<string, number> }>;
      }>;
    };
    // own-prefix mirror chunk skipped: own aggregation comes from kv only
    expect(result.own[0]!.byCategory).toEqual({});
    expect(result.shared).toHaveLength(1);
    expect(result.shared[0]!.ownerUserId).toBe("other");
    expect(result.shared[0]!.months[0]!.byCategory).toEqual({ groceries: 2_000 });

    // Owner missing from the active list (deleted/deactivated), or no list at all: dropped.
    for (const extra of [{ activeUserIds: ["u"] }, {}]) {
      const dropped = (await reportsSpendingHandler(ports)({
        actorUserId: "u",
        months: 1,
        ...extra
      })) as { shared: unknown[] };
      expect(dropped.shared).toEqual([]);
    }
  });
});

describe("finance.reports.net-worth", () => {
  it("derives the series from own accounts + snapshots off the ports clock", async () => {
    const kv = fakeKv();
    await kv.set(NS.accounts, "acc-1", {
      accountId: "acc-1",
      itemId: "item-1",
      name: "Checking",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: "0000",
      balanceCents: 999,
      isoCurrency: "USD",
      updatedAt: "2026-07-18T00:00:00Z"
    });
    await kv.set(NS.snapshots, "acc-1:2026-07", {
      days: { "2026-07-02": 1_000, "2026-07-10": 3_000 }
    });
    const ports = fakePorts(kv, throwingMirror());
    const result = (await reportsNetWorthHandler(ports)({ actorUserId: "u" })) as {
      window: string[];
      points: Array<{ date: string; totalCents: number }>;
      headlineCents: number | null;
    };
    expect(result.window).toHaveLength(6);
    expect(result.points).toEqual([
      { date: "2026-07-02", totalCents: 1_000 },
      { date: "2026-07-10", totalCents: 3_000 }
    ]);
    // headline from snapshots, NOT the live balanceCents (999)
    expect(result.headlineCents).toBe(3_000);
  });
});
