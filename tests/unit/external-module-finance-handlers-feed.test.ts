// tests/unit/external-module-finance-handlers-feed.test.ts
import { describe, expect, it } from "vitest";

import {
  contentHash,
  DEFAULT_CATEGORIES,
  itemKey,
  kvStore,
  NS
} from "../../external-modules/finance/src/domain/index.js";
import type {
  ActivityInput,
  FinanceKv,
  SharedMirrorKv,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  sharedMetaKey,
  sharedMonthKey
} from "../../external-modules/finance/src/domain/shared-pool.js";
import {
  categorizeApplyHandler,
  reviewApplyHandler,
  transactionCategorizeHandler,
  transactionCategorizeNewHandler,
  transactionsQueryHandler
} from "../../external-modules/finance/src/worker/handlers/feed.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// FIN-02 (#1147) Task 10: the feed surface. Contracts pinned here:
// transactions.query is a one-call read (transactions + categories +
// accounts) that defaults to the current month and NEVER writes (the sync
// run owns taxonomy seeding); the categorize tool is the only writer of
// user provenance and notes; the categorize-apply QUEUE path accepts the
// four identifier ids only — notes stay off job payloads (D6).

const NOW = new Date("2026-07-18T12:00:00Z");
const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

function fakeKv(): FinanceKv & { ops: { namespace: string; key: string }[] } {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const ops: { namespace: string; key: string }[] = [];
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
      ops.push({ namespace, key });
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()],
    ops
  };
}

// FIN-04 (#1149): transactions.query LISTS/GETS the mirror (merged household
// read) but must never mutate it. Categorize handlers must not touch it at
// all — they keep the default throwing mirror below.
function readOnlyMirror(seed?: Record<string, Record<string, unknown>>): SharedMirrorKv {
  const store = new Map(Object.entries(seed ?? {}));
  return {
    get: async (key) => structuredClone(store.get(key) ?? null),
    set: async () => {
      throw new Error("feed reads must not write the household mirror");
    },
    delete: async () => {
      throw new Error("feed reads must not delete from the household mirror");
    },
    list: async () => [...store.keys()]
  };
}

// Feed handlers are pure KV reads/writes: any touch of Plaid credentials,
// the token map, or instance settings is a contract violation, so every
// non-kv port throws on use.
function fakePorts(
  kv: FinanceKv,
  mirror?: SharedMirrorKv,
  activity: ActivityInput[] = []
): WorkerPorts {
  return {
    kv,
    // Default: categorize handlers are mirror-blind (share/sync territory).
    mirror: mirror ?? {
      get: async () => {
        throw new Error("feed handlers must not read the household mirror");
      },
      set: async () => {
        throw new Error("feed handlers must not write the household mirror");
      },
      delete: async () => {
        throw new Error("feed handlers must not delete from the household mirror");
      },
      list: async () => {
        throw new Error("feed handlers must not list the household mirror");
      }
    },
    ai: null,
    db: null,
    plaid: null,
    tokens: {
      read: async () => {
        throw new Error("feed handlers must not read tokens");
      },
      write: async () => {
        throw new Error("feed handlers must not write tokens");
      }
    },
    creds: {
      get: async () => {
        throw new Error("feed handlers must not read creds");
      }
    },
    settings: {
      getEnvironment: async () => {
        throw new Error("feed handlers must not read settings");
      }
    },
    isAdmin: false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => ({
      ...kvStore(kv),
      appendActivity: async (entry) => {
        activity.push(entry);
      }
    })
  };
}

function txRecord(over: Partial<TransactionRecord> & { id: string }): TransactionRecord {
  return {
    accountId: "acc-1",
    date: "2026-07-10",
    amountCents: 1234,
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

async function seedAccount(kv: FinanceKv, accountId: string): Promise<void> {
  await kv.set(NS.accounts, accountId, {
    accountId,
    itemId: "item-1",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    balanceCents: 500000,
    isoCurrency: "USD",
    updatedAt: "2026-07-18T00:00:00Z"
  });
}

async function seedFeed(kv: FinanceKv): Promise<void> {
  await seedAccount(kv, "acc-1");
  await seedAccount(kv, "acc-2");
  await kv.set(NS.connections, itemKey("item-1"), {
    itemId: "item-1",
    institutionId: "ins-1",
    connectedAt: "2026-07-01T00:00:00Z",
    status: "connected"
  });
  await kv.set(NS.transactions, "acc-1:2026-07", {
    transactions: [
      txRecord({ id: "t-a", date: "2026-07-15", name: "Some Diner" }),
      txRecord({ id: "t-b", date: "2026-07-10", categoryId: "dining", pending: true })
    ]
  });
  await kv.set(NS.transactions, "acc-2:2026-07", {
    transactions: [
      txRecord({ id: "t-c", accountId: "acc-2", date: "2026-07-12", merchant: "Coffee Shop" })
    ]
  });
  await kv.set(NS.transactions, "acc-1:2026-06", {
    transactions: [txRecord({ id: "t-old", date: "2026-06-20" })]
  });
}

function ids(result: Record<string, unknown>): string[] {
  return (result.transactions as TransactionRecord[]).map((record) => record.id);
}

describe("finance feed handlers (#1147)", () => {
  it("query defaults to the current month and returns the feed in one call", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const writesBefore = kv.ops.length;
    const result = await transactionsQueryHandler(fakePorts(kv, readOnlyMirror()))({
      actorUserId: ACTOR
    });
    // Cross-account merge, date desc then id asc; June stays out.
    expect(ids(result)).toEqual(["t-a", "t-c", "t-b"]);
    // One-call feed: categories + accounts ride along.
    const categories = result.categories as { id: string }[];
    expect(categories.map((category) => category.id)).toEqual(
      DEFAULT_CATEGORIES.map((category) => category.id)
    );
    const accounts = result.accounts as { accountId: string }[];
    expect(accounts.map((account) => account.accountId)).toEqual(["acc-1", "acc-2"]);
    // Reads never write: taxonomy seeding belongs to the sync run alone.
    expect(kv.ops.length).toBe(writesBefore);
  });

  it("query filters by month, account, category, search, and pending", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const query = transactionsQueryHandler(fakePorts(kv, readOnlyMirror()));
    const handler = (input: Record<string, unknown>) => query({ actorUserId: ACTOR, ...input });
    expect(ids(await handler({ month: "2026-06" }))).toEqual(["t-old"]);
    expect(ids(await handler({ accountId: "acc-1" }))).toEqual(["t-a", "t-b"]);
    expect(ids(await handler({ categoryId: "dining" }))).toEqual(["t-b"]);
    // Search is case-insensitive over name AND merchant.
    expect(ids(await handler({ search: "DINER" }))).toEqual(["t-a"]);
    expect(ids(await handler({ search: "coffee" }))).toEqual(["t-c"]);
    expect(ids(await handler({ pendingOnly: true }))).toEqual(["t-b"]);
  });

  it("query requires the host-injected actorUserId (#1149 spoof defense)", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    await expect(transactionsQueryHandler(fakePorts(kv, readOnlyMirror()))({})).rejects.toThrow(
      /actorUserId is required/
    );
  });

  it("query defaults limit to 50, allows up to 2000, rejects beyond, and reports the total", async () => {
    const kv = fakeKv();
    await seedAccount(kv, "acc-1");
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: Array.from({ length: 60 }, (_, index) =>
        txRecord({ id: `t-${String(index).padStart(2, "0")}` })
      )
    });
    const query = transactionsQueryHandler(fakePorts(kv, readOnlyMirror()));
    const handler = (input: Record<string, unknown>) => query({ actorUserId: ACTOR, ...input });
    expect(ids(await handler({})).length).toBe(50);
    expect(ids(await handler({ limit: 200 })).length).toBe(60);
    await expect(handler({ limit: 2001 })).rejects.toThrow("at most 2000");
    // The total lets the screen offer Show more (review A11).
    expect((await handler({ limit: 10 })).totalCount).toBe(60);
    await expect(handler({ month: "July 2026" })).rejects.toThrow("month must be YYYY-MM");
  });

  it("categorize-new sets user provenance, confirms the row, and persists notes", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    // t-a is a needs_look guess from a merchant nobody has confirmed yet.
    const chunk0 = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: TransactionRecord[];
    };
    const guess = chunk0.transactions.find((record) => record.id === "t-a")!;
    guess.categoryId = "dining";
    guess.categorizedBy = "ai";
    guess.reviewState = "needs_look";
    guess.aiConfidence = 0.4;
    await kv.set(NS.transactions, "acc-1:2026-07", chunk0);

    const result = await transactionCategorizeNewHandler(fakePorts(kv))({
      transactionId: "t-a",
      accountId: "acc-1",
      month: "2026-07",
      categoryId: "groceries",
      amountCents: 1234,
      notes: "weekly shop"
    });
    expect(result.status).toBe("ok");
    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: TransactionRecord[];
    };
    const updated = chunk.transactions.find((record) => record.id === "t-a")!;
    expect(updated).toMatchObject({
      categoryId: "groceries",
      categorizedBy: "user",
      reviewState: "confirmed",
      notes: "weekly shop"
    });
    // Sibling records untouched; the tool no longer writes rules.
    expect(chunk.transactions.find((record) => record.id === "t-b")!.categoryId).toBe("dining");
    expect(await kv.list(NS.rules)).toEqual([]);
  });

  it("categorize sorts a merchant with confirmed history and refuses a new one", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const ids = { accountId: "acc-1", month: "2026-07", categoryId: "groceries" };
    // t-b is "ACME" with a confirmed category: the merchant has history.
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: [
        txRecord({ id: "t-a", date: "2026-07-15", name: "Some Diner" }),
        txRecord({ id: "t-b", date: "2026-07-10", categoryId: "dining", name: "ACME #1" }),
        txRecord({ id: "t-c", date: "2026-07-11", name: "ACME #2" })
      ]
    });
    const routine = transactionCategorizeHandler(fakePorts(kv));
    const sortNew = transactionCategorizeNewHandler(fakePorts(kv));

    await expect(
      routine({ ...ids, transactionId: "t-a", amountCents: 1234 })
    ).rejects.toMatchObject({ code: "new_merchant" });
    await expect(
      sortNew({ ...ids, transactionId: "t-c", amountCents: 1234 })
    ).rejects.toMatchObject({ code: "merchant_seen" });

    expect((await routine({ ...ids, transactionId: "t-c", amountCents: 1234 })).status).toBe("ok");
    expect((await sortNew({ ...ids, transactionId: "t-a", amountCents: 1234 })).status).toBe("ok");
  });

  it("a needs_look guess does not count as history for its merchant", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: [
        txRecord({
          id: "t-a",
          name: "Some Diner",
          categoryId: "dining",
          categorizedBy: "ai",
          reviewState: "needs_look",
          aiConfidence: 0.9
        }),
        txRecord({ id: "t-d", name: "Some Diner 2" })
      ]
    });
    await expect(
      transactionCategorizeHandler(fakePorts(kv))({
        transactionId: "t-d",
        accountId: "acc-1",
        month: "2026-07",
        categoryId: "dining",
        amountCents: 1234
      })
    ).rejects.toMatchObject({ code: "new_merchant" });
  });

  it("categorize rejects an amount that differs from the stored transaction", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const call = (amountCents: unknown) =>
      transactionCategorizeNewHandler(fakePorts(kv))({
        transactionId: "t-a",
        accountId: "acc-1",
        month: "2026-07",
        categoryId: "dining",
        amountCents
      });
    await expect(call(9999)).rejects.toMatchObject({ code: "amount_mismatch" });
    await expect(call(undefined)).rejects.toThrow("amountCents is required");
    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: TransactionRecord[];
    };
    expect(chunk.transactions.find((record) => record.id === "t-a")!.categoryId).toBeNull();
  });

  it("rejects unknown transaction ids and unknown or archived categories", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    await kv.set(NS.categories, "taxonomy", {
      categories: [
        ...DEFAULT_CATEGORIES,
        { id: "old-cat", group: "personal", name: "Old", archived: true }
      ]
    });
    const apply = categorizeApplyHandler(fakePorts(kv));
    // The queue envelope the host actually delivers (apps/worker/src/
    // external-module-job-handler.ts): ids ride in `params`, never top-level.
    const envelope = (params: Record<string, unknown>) => ({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      jobKind: "finance.categorize-apply",
      idempotencyKey: "finance:finance.categorize-apply:job-1",
      params
    });
    const base = { accountId: "acc-1", month: "2026-07", categoryId: "dining" };
    await expect(apply(envelope({ ...base, transactionId: "t-missing" }))).rejects.toMatchObject({
      code: "not_found"
    });
    await expect(
      apply(envelope({ ...base, transactionId: "t-a", categoryId: "nope" }))
    ).rejects.toMatchObject({ code: "invalid_category" });
    await expect(
      apply(envelope({ ...base, transactionId: "t-a", categoryId: "old-cat" }))
    ).rejects.toMatchObject({ code: "invalid_category" });
  });

  it("queue path reads ids from the job envelope's params and never persists notes (D6)", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    // Regression (#1147 UAT run 1): the host invokes queue handlers with the
    // full job envelope { actorUserId, jobKind, idempotencyKey, params } —
    // reading ids from the top level made every real queued job die with
    // invalid_input while the flat-input unit test stayed green. This test
    // now models the envelope exactly as external-module-job-handler.ts
    // builds it. The manifest paramsSchema already rejects extra keys
    // host-side; the handler ignoring notes is defense in depth.
    await categorizeApplyHandler(fakePorts(kv))({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      jobKind: "finance.categorize-apply",
      idempotencyKey: "finance:finance.categorize-apply:job-1",
      params: {
        transactionId: "t-a",
        accountId: "acc-1",
        month: "2026-07",
        categoryId: "transport",
        notes: "must not land"
      }
    });
    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: TransactionRecord[];
    };
    const updated = chunk.transactions.find((record) => record.id === "t-a")!;
    expect(updated).toMatchObject({ categoryId: "transport", categorizedBy: "user" });
    expect(updated.notes).toBeUndefined();
    expect(await kv.list(NS.rules)).toEqual([]);
  });

  it("queue path logs a user activity row with ids only and undo to the old category (#3174)", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const activity: ActivityInput[] = [];
    await categorizeApplyHandler(fakePorts(kv, undefined, activity))({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      jobKind: "finance.categorize-apply",
      idempotencyKey: "finance:finance.categorize-apply:job-2",
      params: {
        transactionId: "t-a",
        accountId: "acc-1",
        month: "2026-07",
        categoryId: "transport"
      }
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      actor: "user",
      kind: "transaction.categorize",
      params: { transactionId: "t-a", categoryId: "transport" }
    });
    expect(activity[0]!.undo).toMatchObject({ transactionId: "t-a" });
  });
});

// FIN-04 (#1149) Task 5: transactions.query merges OTHER owners' shared
// month chunks from the finance.shared mirror BEFORE filters/sort/limit, so
// category/search/pending filters treat shared rows exactly like own rows.
// Own-prefix mirror chunks are skipped (own user-scoped records are
// authoritative); merged rows are tagged { ownerUserId, shared: true }.
describe("finance transactions.query household merge (#1149)", () => {
  function sharedMirror(): SharedMirrorKv {
    return readOnlyMirror({
      // Shape = SharedAccountMeta: Plaid plumbing never enters the mirror.
      [sharedMetaKey(OTHER, "acc-x")]: {
        ownerUserId: OTHER,
        accountId: "acc-x",
        name: "Joint Checking",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: "4444",
        balanceCents: 300000,
        isoCurrency: "USD",
        updatedAt: "2026-07-18T05:00:00Z"
      },
      [sharedMonthKey(OTHER, "acc-x", "2026-07")]: {
        transactions: [
          txRecord({ id: "t-x1", accountId: "acc-x", date: "2026-07-14", name: "Joint Diner" }),
          txRecord({
            id: "t-x2",
            accountId: "acc-x",
            date: "2026-07-11",
            categoryId: "dining",
            pending: true
          })
        ]
      },
      [sharedMonthKey(OTHER, "acc-x", "2026-06")]: {
        transactions: [txRecord({ id: "t-x-old", accountId: "acc-x", date: "2026-06-05" })]
      },
      // Own-prefix mirror chunk duplicating t-a — MUST be skipped.
      [sharedMonthKey(ACTOR, "acc-1", "2026-07")]: {
        transactions: [txRecord({ id: "t-a", date: "2026-07-15" })]
      }
    });
  }

  it("merges shared rows into date order, tagged with their owner", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const writesBefore = (kv as ReturnType<typeof fakeKv>).ops.length;
    const result = await transactionsQueryHandler(fakePorts(kv, sharedMirror()))({
      actorUserId: ACTOR,
      activeUserIds: [ACTOR, OTHER],
      limit: 200
    });
    expect(ids(result)).toEqual(["t-a", "t-x1", "t-c", "t-x2", "t-b"]);
    const rows = result.transactions as Record<string, unknown>[];
    expect(rows.find((row) => row.id === "t-x1")).toMatchObject({
      ownerUserId: OTHER,
      shared: true
    });
    // Own rows never carry the tag.
    expect(rows.find((row) => row.id === "t-a")).not.toHaveProperty("ownerUserId");
    // The shared account rides along in the one-call accounts list.
    const accounts = result.accounts as { accountId: string }[];
    expect(accounts.map((account) => account.accountId)).toEqual(["acc-1", "acc-2", "acc-x"]);
    // Merged reads stay pure — no cache warming, no GC-on-read.
    expect((kv as ReturnType<typeof fakeKv>).ops.length).toBe(writesBefore);
  });

  it("applies category, search, and pending filters to shared rows too", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const query = transactionsQueryHandler(fakePorts(kv, sharedMirror()));
    const handler = (input: Record<string, unknown>) =>
      query({ actorUserId: ACTOR, activeUserIds: [ACTOR, OTHER], ...input });
    expect(ids(await handler({ categoryId: "dining" }))).toEqual(["t-x2", "t-b"]);
    expect(ids(await handler({ search: "joint" }))).toEqual(["t-x1"]);
    expect(ids(await handler({ pendingOnly: true }))).toEqual(["t-x2", "t-b"]);
    expect(ids(await handler({ month: "2026-06" }))).toEqual(["t-old", "t-x-old"]);
  });

  it("honors an accountId filter that targets a shared account", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const result = await transactionsQueryHandler(fakePorts(kv, sharedMirror()))({
      actorUserId: ACTOR,
      activeUserIds: [ACTOR, OTHER],
      accountId: "acc-x"
    });
    expect(ids(result)).toEqual(["t-x1", "t-x2"]);
  });

  it("drops rows and accounts of owners missing from the active list, and fails closed without it", async () => {
    const kv = fakeKv();
    await seedFeed(kv);
    const query = transactionsQueryHandler(fakePorts(kv, sharedMirror()));
    for (const extra of [{ activeUserIds: [ACTOR] }, {}]) {
      const result = await query({ actorUserId: ACTOR, limit: 200, ...extra });
      expect(ids(result)).toEqual(["t-a", "t-c", "t-b"]);
      const accounts = result.accounts as { accountId: string }[];
      expect(accounts.map((account) => account.accountId)).toEqual(["acc-1", "acc-2"]);
    }
  });
});

// #3176: the Transactions screen. The query counts and filters rows that need a
// look; the review-apply queue confirms rows (all-or-nothing) and makes a merchant
// rule only when asked, for a single row.
describe("finance review (#3176)", () => {
  async function seedReview(kv: FinanceKv): Promise<void> {
    await seedAccount(kv, "acc-1");
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: [
        txRecord({
          id: "r-1",
          name: "Blue Bottle 12",
          categoryId: "dining",
          reviewState: "needs_look"
        }),
        txRecord({
          id: "r-2",
          name: "Shell Oil",
          categoryId: "transport",
          reviewState: "needs_look"
        }),
        txRecord({ id: "r-3", name: "Rent", categoryId: "housing", reviewState: "confirmed" }),
        txRecord({ id: "r-4", name: "Blue Bottle 99", categoryId: "dining" })
      ]
    });
  }
  const envelope = (params: Record<string, unknown>) => ({
    actorUserId: ACTOR,
    jobKind: "finance.review-apply",
    idempotencyKey: "k",
    params
  });
  const rows = async (kv: FinanceKv) =>
    ((await kv.get(NS.transactions, "acc-1:2026-07")) as { transactions: TransactionRecord[] })
      .transactions;

  it("query counts rows that need a look and can show only those", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const query = transactionsQueryHandler(fakePorts(kv, readOnlyMirror()));
    const all = await query({ actorUserId: ACTOR, month: "2026-07" });
    expect(all.needsLookCount).toBe(2);
    expect(ids(all)).toHaveLength(4);
    const look = await query({ actorUserId: ACTOR, month: "2026-07", needsLookOnly: true });
    expect(ids(look).sort()).toEqual(["r-1", "r-2"]);
    expect(look.needsLookCount).toBe(2);
    // The count follows search, so Confirm all matches what search shows.
    const searched = await query({ actorUserId: ACTOR, month: "2026-07", search: "shell" });
    expect(searched.needsLookCount).toBe(1);
  });

  it("confirms the listed rows with no merchant rule", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    await reviewApplyHandler(fakePorts(kv))(
      envelope({
        transactionIds: ["r-1", "r-2"],
        accountIds: ["acc-1", "acc-1"],
        months: ["2026-07", "2026-07"],
        categoryIds: ["dining", "transport"]
      })
    );
    const after = await rows(kv);
    expect(after.filter((r) => r.reviewState === "needs_look")).toEqual([]);
    expect(after.find((r) => r.id === "r-3")!.categorizedBy).toBeNull();
    expect(await kv.list(NS.rules)).toEqual([]);
  });

  it("changes one category and makes a merchant rule only when asked", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const one = {
      transactionIds: ["r-1"],
      accountIds: ["acc-1"],
      months: ["2026-07"],
      categoryIds: ["groceries"]
    };
    await reviewApplyHandler(fakePorts(kv))(envelope({ ...one, createRule: false }));
    expect(await kv.list(NS.rules)).toEqual([]);
    expect((await rows(kv)).find((r) => r.id === "r-1")).toMatchObject({
      categoryId: "groceries",
      reviewState: "confirmed"
    });
    await reviewApplyHandler(fakePorts(kv))(envelope({ ...one, createRule: true }));
    const keys = await kv.list(NS.rules);
    expect(keys).toHaveLength(1);
    expect(await kv.get(NS.rules, keys[0]!)).toMatchObject({
      payeeKey: "blue bottle",
      categoryId: "groceries"
    });
  });

  it("changes nothing when any row is invalid, and refuses rules on a batch", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const before = JSON.stringify(await rows(kv));
    await expect(
      reviewApplyHandler(fakePorts(kv))(
        envelope({
          transactionIds: ["r-1", "nope"],
          accountIds: ["acc-1", "acc-1"],
          months: ["2026-07", "2026-07"],
          categoryIds: ["dining", "dining"]
        })
      )
    ).rejects.toThrow();
    await expect(
      reviewApplyHandler(fakePorts(kv))(
        envelope({
          transactionIds: ["r-1", "r-2"],
          accountIds: ["acc-1", "acc-1"],
          months: ["2026-07", "2026-07"],
          categoryIds: ["dining", "transport"],
          createRule: true
        })
      )
    ).rejects.toThrow();
    expect(JSON.stringify(await rows(kv))).toBe(before);
  });

  it("logs a user activity row per changed row, a confirm row per unchanged row (review finding 4)", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const activity: ActivityInput[] = [];
    await reviewApplyHandler(fakePorts(kv, undefined, activity))(
      envelope({
        transactionIds: ["r-1", "r-2"],
        accountIds: ["acc-1", "acc-1"],
        months: ["2026-07", "2026-07"],
        categoryIds: ["groceries", "transport"]
      })
    );
    expect(activity.map((entry) => [entry.actor, entry.kind])).toEqual([
      ["user", "transaction.categorize"],
      ["user", "transaction.confirm"]
    ]);
    expect(activity[0]!.params).toMatchObject({
      transactionId: "r-1",
      categoryId: "groceries",
      previousCategoryId: "dining"
    });
    expect(activity[0]!.undo).toMatchObject({ transactionId: "r-1", categoryId: "dining" });
  });

  it("logs the merchant rule it makes (review finding 4)", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const activity: ActivityInput[] = [];
    await reviewApplyHandler(fakePorts(kv, undefined, activity))(
      envelope({
        transactionIds: ["r-1"],
        accountIds: ["acc-1"],
        months: ["2026-07"],
        categoryIds: ["groceries"],
        createRule: true
      })
    );
    expect(activity.map((entry) => entry.kind)).toEqual([
      "transaction.categorize",
      "merchant-rule.set"
    ]);
    expect(activity.every((entry) => entry.actor === "user")).toBe(true);
    expect(activity[1]!.params).toMatchObject({ categoryId: "groceries" });
  });

  it("writes one rule per merchant and removes the old-format key (review finding 5)", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const legacyKey = contentHash("blue bottle");
    await kv.set(NS.rules, legacyKey, {
      payeeKey: "blue bottle",
      categoryId: "dining",
      createdAt: "2026-06-01T00:00:00Z"
    });
    await reviewApplyHandler(fakePorts(kv))(
      envelope({
        transactionIds: ["r-1"],
        accountIds: ["acc-1"],
        months: ["2026-07"],
        categoryIds: ["groceries"],
        createRule: true
      })
    );
    expect(await kv.list(NS.rules)).toEqual([`rule:${legacyKey}`]);
    expect(await kv.get(NS.rules, `rule:${legacyKey}`)).toMatchObject({ categoryId: "groceries" });
  });

  it("loads categories and each month chunk once for the whole batch (review finding 9)", async () => {
    const kv = fakeKv();
    await seedReview(kv);
    const ports = fakePorts(kv);
    const inner = await ports.store();
    let chunkReads = 0;
    const counting: WorkerPorts = {
      ...ports,
      store: async () => ({
        ...inner,
        getTransactionChunk: async (accountId, month) => {
          chunkReads += 1;
          return inner.getTransactionChunk(accountId, month);
        }
      })
    };
    await reviewApplyHandler(counting)(
      envelope({
        transactionIds: ["r-1", "r-2", "r-3"],
        accountIds: ["acc-1", "acc-1", "acc-1"],
        months: ["2026-07", "2026-07", "2026-07"],
        categoryIds: ["dining", "transport", "rent-mortgage"]
      })
    );
    expect(chunkReads).toBe(1);
  });
});
