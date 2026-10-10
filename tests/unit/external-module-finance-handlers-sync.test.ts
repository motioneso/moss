// tests/unit/external-module-finance-handlers-sync.test.ts
import { FinanceFetchError } from "../../external-modules/finance/src/adapters/types.js";
import { describe, expect, it, vi } from "vitest";

import type {
  PlaidAccount,
  PlaidClient,
  PlaidTx
} from "../../external-modules/finance/src/adapters/plaid.js";
import { PlaidError } from "../../external-modules/finance/src/adapters/plaid.js";
import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type { ActivityInput, FinanceKv } from "../../external-modules/finance/src/domain/index.js";
import { syncRunHandler } from "../../external-modules/finance/src/worker/handlers/sync.js";
import type { TokenMap, WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { InputError } from "../../external-modules/finance/src/worker/validate.js";

// FIN-01 (#1146) Task 6: sync.run — one handler behind both the
// finance.sync-run queue and the finance.sync.run-now tool (D3). Contracts
// pinned here: the cursor for a page is persisted only AFTER that page's
// chunks are written (at-least-once + idempotent reducer = no data loss),
// balance snapshots append once per day, item failures are isolated (a
// broken bank never blocks the others), the D5 token-map guard aborts the
// whole run, and the per-run page loop is bounded at 100.

const NOW = new Date("2026-07-18T12:00:00Z");
const TODAY = "2026-07-18";

type KvOp = { key: string; namespace: string; value: Record<string, unknown> };

function fakeKv(): FinanceKv & { ops: KvOp[] } {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const ops: KvOp[] = [];
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
      ops.push({ namespace, key, value: structuredClone(value) });
      ns(namespace).set(key, structuredClone(value));
    },
    delete: async (namespace, key) => ns(namespace).delete(key),
    list: async (namespace) => [...ns(namespace).keys()],
    ops
  };
}

function balanceAccount(over: Partial<PlaidAccount> = {}): PlaidAccount {
  return {
    accountId: "acc-1",
    name: "Checking",
    officialName: null,
    type: "depository",
    subtype: "checking",
    mask: "0000",
    balanceCents: 500000,
    isoCurrency: "USD",
    ...over
  };
}

function tx(over: Partial<PlaidTx> & { transaction_id: string }): PlaidTx {
  return {
    account_id: "acc-1",
    date: "2026-07-10",
    amount: 12.34,
    iso_currency_code: "USD",
    name: "COFFEE SHOP",
    merchant_name: "Coffee Shop",
    personal_finance_category: { primary: "FOOD_AND_DRINK" },
    pending: false,
    pending_transaction_id: null,
    ...over
  };
}

type SyncPageResult = Awaited<ReturnType<PlaidClient["transactionsSync"]>>;

function syncPage(over: Partial<SyncPageResult> = {}): SyncPageResult {
  return { added: [], modified: [], removed: [], nextCursor: "c-end", hasMore: false, ...over };
}

type PlaidOverrides = Partial<PlaidClient>;

function fakePlaid(overrides: PlaidOverrides = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, impl: (...args: never[]) => unknown) =>
    (...args: never[]) => {
      calls.push({ method, args: [...args] });
      return impl(...args);
    };
  const client: PlaidClient = {
    linkTokenCreate: record(
      "linkTokenCreate",
      overrides.linkTokenCreate ?? (async () => ({ linkToken: "l", hostedLinkUrl: "u" }))
    ) as PlaidClient["linkTokenCreate"],
    linkTokenGet: record(
      "linkTokenGet",
      overrides.linkTokenGet ?? (async () => ({ status: "pending" as const, publicTokens: [] }))
    ) as PlaidClient["linkTokenGet"],
    itemPublicTokenExchange: record(
      "itemPublicTokenExchange",
      overrides.itemPublicTokenExchange ?? (async () => ({ accessToken: "a", itemId: "i" }))
    ) as PlaidClient["itemPublicTokenExchange"],
    accountsGet: record(
      "accountsGet",
      overrides.accountsGet ?? (async () => ({ institutionId: null, accounts: [] }))
    ) as PlaidClient["accountsGet"],
    institutionGet: record(
      "institutionGet",
      overrides.institutionGet ?? (async () => ({ name: "Sandbox First Bank" }))
    ) as PlaidClient["institutionGet"],
    accountsBalanceGet: record(
      "accountsBalanceGet",
      overrides.accountsBalanceGet ?? (async () => ({ accounts: [balanceAccount()] }))
    ) as PlaidClient["accountsBalanceGet"],
    transactionsSync: record(
      "transactionsSync",
      overrides.transactionsSync ?? (async () => syncPage())
    ) as PlaidClient["transactionsSync"]
  };
  const callsTo = (method: string) => calls.filter((c) => c.method === method);
  return { client, calls, callsTo };
}

function fakePorts(opts: { kv?: FinanceKv; plaid?: PlaidClient | null; tokens?: TokenMap | null }) {
  const kv = opts.kv ?? fakeKv();
  const plaidFactoryCalls: { env: string }[] = [];
  // FIN-04 (#1149): sync now reconciles its own mirror prefix on every run,
  // so the mirror port must be functional (in-memory) — the dedicated
  // handlers-shared suite owns the behavioral assertions.
  const mirrorStore = new Map<string, Record<string, unknown>>();
  const ports: WorkerPorts = {
    kv,
    mirror: {
      get: async (key) => structuredClone(mirrorStore.get(key) ?? null),
      set: async (key, value) => {
        mirrorStore.set(key, structuredClone(value));
      },
      delete: async (key) => mirrorStore.delete(key),
      list: async () => [...mirrorStore.keys()]
    },
    ai: null,
    db: null,
    plaid:
      opts.plaid === null || opts.plaid === undefined
        ? null
        : (env) => {
            plaidFactoryCalls.push({ env });
            return opts.plaid!;
          },
    tokens: {
      read: async () => opts.tokens ?? null,
      write: async () => {
        throw new Error("sync must never write the token map");
      }
    },
    creds: { get: async () => ({ clientId: "client-id-7f3a", secret: "secret-9b2c" }) },
    settings: { getEnvironment: async () => "sandbox" },
    isAdmin: false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => kvStore(kv)
  };
  return { ports, kv, plaidFactoryCalls };
}

async function seedItem(
  kv: FinanceKv,
  itemId: string,
  status: "connected" | "reauth-required" | "error" = "connected"
) {
  await kv.set(NS.connections, `item:${itemId}`, {
    itemId,
    institutionId: "ins_1",
    connectedAt: "2026-07-01T00:00:00Z",
    status
  });
}

const TOKENS: TokenMap = { "item-1": { accessToken: "access-1", institutionId: "ins_1" } };

describe("finance.sync.run (#1146, D3 shared queue/tool handler)", () => {
  it("returns ok with no items and never builds a Plaid client", async () => {
    const { ports, plaidFactoryCalls } = fakePorts({ plaid: fakePlaid().client, tokens: null });
    const result = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result).toEqual({ status: "ok", items: [] });
    expect(plaidFactoryCalls).toHaveLength(0);
  });

  it("D5: aborts the whole run when the token read fails with items on record", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const { ports } = fakePorts({ kv, plaid: fakePlaid().client, tokens: null });
    const error = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InputError);
    expect((error as InputError).code).toBe("token_read_failed");
    // No partial writes: the abort happens before any item is touched.
    expect(kv.ops).toHaveLength(2); // the seed, then the sync lease being taken
  });

  it("syncs a multi-page run, persisting each cursor only after its chunks", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const pages = [
      syncPage({
        added: [tx({ transaction_id: "t1", date: "2026-07-10" })],
        nextCursor: "c1",
        hasMore: true
      }),
      syncPage({
        added: [tx({ transaction_id: "t2", date: "2026-07-11" })],
        nextCursor: "c2",
        hasMore: false
      })
    ];
    let call = 0;
    const plaid = fakePlaid({ transactionsSync: async () => pages[call++]! });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });

    const result = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result).toEqual({
      status: "ok",
      items: [
        { itemId: "item-1", status: "connected", added: 2, modified: 0, removed: 0, pages: 2 }
      ]
    });

    // Cursor discipline: each page's chunk writes strictly precede that
    // page's cursor write (crash between them = replay, reducer no-ops it).
    const ordered = kv.ops
      .filter((op) => op.namespace === NS.transactions || op.key === "cursor:item-1")
      .map((op) => op.key);
    expect(ordered).toEqual(["acc-1:2026-07", "cursor:item-1", "acc-1:2026-07", "cursor:item-1"]);
    const cursorValues = kv.ops.filter((op) => op.key === "cursor:item-1").map((op) => op.value);
    expect(cursorValues).toEqual([{ cursor: "c1", paginationStart: null }, { cursor: "c2" }]);

    // Cursor threading: first call starts fresh (null), second resumes at c1.
    const syncCalls = plaid.callsTo("transactionsSync").map((c) => c.args[1]);
    expect(syncCalls).toEqual([null, "c1"]);

    // Both transactions landed in the July chunk.
    const chunk = await kv.get(NS.transactions, "acc-1:2026-07");
    expect((chunk as { transactions: { id: string }[] }).transactions.map((r) => r.id)).toEqual([
      "t2",
      "t1"
    ]);

    // Balances → account record + daily snapshot + item bookkeeping.
    expect(await kv.get(NS.accounts, "acc-1")).toMatchObject({
      accountId: "acc-1",
      itemId: "item-1",
      balanceCents: 500000,
      updatedAt: NOW.toISOString()
    });
    expect(await kv.get(NS.snapshots, "acc-1:2026-07")).toEqual({
      days: { [TODAY]: 500000 }
    });
    expect(await kv.get(NS.connections, "item:item-1")).toMatchObject({
      status: "connected",
      lastSyncAt: NOW.toISOString()
    });
  });

  it("resumes from a stored cursor", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.connections, "cursor:item-1", { cursor: "c-stored" });
    const plaid = fakePlaid();
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)({ actorUserId: "00000000-0000-4000-8000-0000000000aa" });
    expect(plaid.callsTo("transactionsSync")[0]!.args[1]).toBe("c-stored");
  });

  it("appends the balance snapshot only once per day", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.snapshots, "acc-1:2026-07", { days: { [TODAY]: 123 } });
    const seedOps = kv.ops.length;
    const { ports } = fakePorts({ kv, plaid: fakePlaid().client, tokens: TOKENS });
    await syncRunHandler(ports)({ actorUserId: "00000000-0000-4000-8000-0000000000aa" });
    const snapshotWrites = kv.ops.slice(seedOps).filter((op) => op.namespace === NS.snapshots);
    expect(snapshotWrites).toHaveLength(0);
    // The stale value survives — today's balance was already recorded.
    expect(await kv.get(NS.snapshots, "acc-1:2026-07")).toEqual({ days: { [TODAY]: 123 } });
  });

  it("isolates item failures: ITEM_LOGIN_REQUIRED marks reauth, others still sync", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await seedItem(kv, "item-2");
    const plaid = fakePlaid({
      accountsBalanceGet: async (accessToken: string) => {
        if (accessToken === "access-1") throw new PlaidError("ITEM_LOGIN_REQUIRED", 400);
        return { accounts: [balanceAccount({ accountId: "acc-2" })] };
      }
    });
    const { ports } = fakePorts({
      kv,
      plaid: plaid.client,
      tokens: {
        "item-1": { accessToken: "access-1", institutionId: "ins_1" },
        "item-2": { accessToken: "access-2", institutionId: "ins_2" }
      }
    });

    const result = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result.items).toEqual([
      { itemId: "item-1", status: "reauth-required", added: 0, modified: 0, removed: 0, pages: 0 },
      { itemId: "item-2", status: "connected", added: 0, modified: 0, removed: 0, pages: 1 }
    ]);
    expect(await kv.get(NS.connections, "item:item-1")).toMatchObject({
      status: "reauth-required",
      lastError: "ITEM_LOGIN_REQUIRED"
    });
    expect(await kv.get(NS.connections, "item:item-2")).toMatchObject({
      status: "connected",
      lastSyncAt: NOW.toISOString()
    });
  });

  it("marks other Plaid errors as error with the code only", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      transactionsSync: async () => {
        throw new PlaidError("INTERNAL_SERVER_ERROR", 500);
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result.items).toEqual([
      { itemId: "item-1", status: "error", added: 0, modified: 0, removed: 0, pages: 0 }
    ]);
    expect(await kv.get(NS.connections, "item:item-1")).toMatchObject({
      status: "error",
      lastError: "INTERNAL_SERVER_ERROR"
    });
  });

  it("marks an item with no token entry as error without calling Plaid for it", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await seedItem(kv, "item-2");
    const plaid = fakePlaid();
    const { ports } = fakePorts({
      kv,
      plaid: plaid.client,
      tokens: { "item-2": { accessToken: "access-2", institutionId: "ins_2" } }
    });
    const result = await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    });
    expect(result.items).toEqual([
      { itemId: "item-1", status: "error", added: 0, modified: 0, removed: 0, pages: 0 },
      { itemId: "item-2", status: "connected", added: 0, modified: 0, removed: 0, pages: 1 }
    ]);
    expect(await kv.get(NS.connections, "item:item-1")).toMatchObject({
      status: "error",
      lastError: "TOKEN_MISSING"
    });
  });

  it("saves the bank name on the next sync and does not look it up again once known", async () => {
    const actor = { actorUserId: "00000000-0000-4000-8000-0000000000aa" };
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid();
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(actor);
    expect(await kv.get(NS.connections, "item:item-1")).toMatchObject({
      institutionName: "Sandbox First Bank"
    });
    expect(plaid.callsTo("institutionGet")).toHaveLength(1);
    await syncRunHandler(ports)(actor);
    expect(plaid.callsTo("institutionGet")).toHaveLength(1);
  });

  it("still finishes the sync when the bank name lookup fails", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      institutionGet: async () => {
        throw new PlaidError("INTERNAL_SERVER_ERROR", 500, {
          type: null,
          message: null,
          requestId: null
        });
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = (await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    })) as { items: Record<string, unknown>[] };
    expect(result.items[0]).toMatchObject({ itemId: "item-1", status: "connected" });
    expect(await kv.get(NS.connections, "item:item-1")).not.toHaveProperty("institutionName");
  });

  it("recovers a reauth-required item to connected after a successful sync", async () => {
    const kv = fakeKv();
    await kv.set(NS.connections, "item:item-1", {
      itemId: "item-1",
      institutionId: "ins_1",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "reauth-required",
      lastError: "ITEM_LOGIN_REQUIRED"
    });
    const { ports } = fakePorts({ kv, plaid: fakePlaid().client, tokens: TOKENS });
    const result = (await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    })) as {
      items: Record<string, unknown>[];
    };
    expect(result.items[0]).toMatchObject({ itemId: "item-1", status: "connected" });
    const item = await kv.get(NS.connections, "item:item-1");
    expect(item).toMatchObject({ status: "connected", lastSyncAt: NOW.toISOString() });
    expect(item).not.toHaveProperty("lastError");
  });

  it("categorizes newly-synced transactions and seeds the taxonomy (#1147)", async () => {
    // FIN-02 Task 9: the identity seam is gone — sync now loads rules +
    // categories (seeding DEFAULT_CATEGORIES on first read) and runs the
    // pipeline over each page's chunks. With ai:null, only rules and the PFC
    // map apply; everything else stays uncategorized (never blocks sync).
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    // A stored payee rule must beat the PFC map for its transaction.
    await kv.set(NS.rules, "rule-1", {
      payeeKey: "coffee shop",
      categoryId: "subscriptions",
      createdAt: "2026-07-01T00:00:00Z"
    });
    const plaid = fakePlaid({
      transactionsSync: async () =>
        syncPage({
          added: [
            tx({ transaction_id: "t-rule", name: "COFFEE SHOP #42" }),
            tx({ transaction_id: "t-pfc", name: "Some Diner" }),
            tx({
              transaction_id: "t-none",
              name: "Mystery Vendor",
              personal_finance_category: null
            })
          ]
        })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)({ actorUserId: "00000000-0000-4000-8000-0000000000aa" });

    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: Record<string, unknown>[];
    };
    const byId = Object.fromEntries(
      chunk.transactions.map((record) => [record.id as string, record])
    );
    expect(byId["t-rule"]).toMatchObject({ categoryId: "subscriptions", categorizedBy: "rule" });
    expect(byId["t-pfc"]).toMatchObject({ categoryId: "dining", categorizedBy: "plaid-map" });
    expect(byId["t-none"]).toMatchObject({
      categoryId: null,
      categorizedBy: null,
      reviewState: "needs_look"
    });

    // First read seeds the default taxonomy so the feed and rules always
    // have a category list to resolve against.
    const taxonomy = (await kv.get(NS.categories, "taxonomy")) as {
      categories: { id: string }[];
    };
    expect(taxonomy.categories.map((category) => category.id)).toContain("dining");
  });

  it("lets the newest rule win when one merchant holds two (review finding 5)", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.rules, "rule:newer", {
      payeeKey: "coffee shop",
      categoryId: "dining",
      createdAt: "2026-08-01T00:00:00Z"
    });
    await kv.set(NS.rules, "aaa-older", {
      payeeKey: "coffee shop",
      categoryId: "subscriptions",
      createdAt: "2026-07-01T00:00:00Z"
    });
    const plaid = fakePlaid({
      transactionsSync: async () =>
        syncPage({ added: [tx({ transaction_id: "t-rule", name: "COFFEE SHOP #42" })] })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)({ actorUserId: "00000000-0000-4000-8000-0000000000aa" });
    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: Record<string, unknown>[];
    };
    expect(chunk.transactions[0]).toMatchObject({ categoryId: "dining" });
  });

  describe("review state (#3175)", () => {
    type Tier = "ask_each_time" | "trusted_auto" | "always_confirm";
    const ACTOR = "00000000-0000-4000-8000-0000000000aa";

    async function runWithTiers(
      tiers: Partial<Record<string, Tier | "throw">>,
      activity: ActivityInput[] = []
    ) {
      const kv = fakeKv();
      await seedItem(kv, "item-1");
      // A confirmed, categorized earlier row makes "Known Diner" a seen merchant.
      await kv.set(NS.transactions, "acc-1:2026-06", {
        transactions: [
          {
            id: "t-old",
            accountId: "acc-1",
            date: "2026-06-10",
            amountCents: 900,
            isoCurrency: "USD",
            name: "Known Diner 7",
            merchant: null,
            plaidCategory: null,
            categoryId: "dining",
            pending: false,
            pendingTransactionId: null,
            categorizedBy: "user"
          }
        ]
      });
      const plaid = fakePlaid({
        transactionsSync: async () =>
          syncPage({
            added: [
              tx({ transaction_id: "t-seen", name: "Known Diner 8" }),
              tx({ transaction_id: "t-new", name: "Some Diner" })
            ]
          })
      });
      const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
      const withPolicy: WorkerPorts = {
        ...ports,
        store: async () => ({
          ...kvStore(kv),
          appendActivity: async (entry) => {
            activity.push(entry);
          }
        }),
        actionPolicy: {
          get: async (familyId) => {
            const tier = tiers[familyId];
            if (tier === "throw") throw new Error("rpc_failed");
            return tier ?? "ask_each_time";
          }
        }
      };
      await syncRunHandler(withPolicy)({ actorUserId: ACTOR });
      const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
        transactions: Record<string, unknown>[];
      };
      return Object.fromEntries(chunk.transactions.map((record) => [record.id as string, record]));
    }

    it("sorting trusted and sorting_new asking: seen merchant confirmed, new one needs a look", async () => {
      const byId = await runWithTiers({ sorting: "trusted_auto", sorting_new: "ask_each_time" });
      expect(byId["t-seen"]).toMatchObject({ categoryId: "dining", reviewState: "confirmed" });
      expect(byId["t-new"]).toMatchObject({ categoryId: "dining", reviewState: "needs_look" });
    });

    it("sorting asking and sorting_new trusted: the reverse", async () => {
      const byId = await runWithTiers({ sorting: "ask_each_time", sorting_new: "trusted_auto" });
      expect(byId["t-seen"]).toMatchObject({ reviewState: "needs_look" });
      expect(byId["t-new"]).toMatchObject({ reviewState: "confirmed" });
    });

    it("logs an activity row (actor moss, ids only) for each guess Moss confirms itself", async () => {
      const activity: ActivityInput[] = [];
      await runWithTiers({ sorting: "trusted_auto", sorting_new: "ask_each_time" }, activity);
      expect(activity).toEqual([
        {
          actor: "moss",
          kind: "transaction.categorize",
          params: {
            transactionId: "t-seen",
            accountId: "acc-1",
            month: "2026-07",
            categoryId: "dining",
            previousCategoryId: null
          },
          undo: {
            transactionId: "t-seen",
            accountId: "acc-1",
            month: "2026-07",
            categoryId: null
          }
        }
      ]);
    });

    it("logs nothing when Moss only suggests and leaves the row for review", async () => {
      const activity: ActivityInput[] = [];
      await runWithTiers({}, activity);
      expect(activity).toEqual([]);
    });

    it("an unreadable tier fails closed to needs_look", async () => {
      const byId = await runWithTiers({ sorting: "throw", sorting_new: "throw" });
      expect(byId["t-seen"]).toMatchObject({ reviewState: "needs_look" });
      expect(byId["t-new"]).toMatchObject({ reviewState: "needs_look" });
    });
  });

  it("bounds a runaway sync at 100 pages per item per run", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    let call = 0;
    const plaid = fakePlaid({
      transactionsSync: async () =>
        syncPage({
          added: [tx({ transaction_id: `t-${call}` })],
          nextCursor: `c-${call++}`,
          hasMore: true
        })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = (await syncRunHandler(ports)({
      actorUserId: "00000000-0000-4000-8000-0000000000aa"
    })) as {
      items: Record<string, unknown>[];
    };
    expect(plaid.callsTo("transactionsSync")).toHaveLength(100);
    expect(result.items[0]).toMatchObject({ status: "connected", pages: 100, added: 100 });
    // Progress is durable: the last cursor is persisted, the next run resumes.
    expect(await kv.get(NS.connections, "cursor:item-1")).toEqual({
      cursor: "c-99",
      paginationStart: null
    });
  });
});

// #3161: a failed live balance check must not block transactions, Plaid's full
// error is kept for diagnosis, removal-only batches delete, mutation-during-
// pagination restarts, and connect triggers a first sync.
describe("finance.sync.run (#3161 sync resilience)", () => {
  const ACTOR = { actorUserId: "00000000-0000-4000-8000-0000000000aa" };
  const invalidProduct = () =>
    new PlaidError("INVALID_PRODUCT", 400, {
      type: "INVALID_REQUEST",
      message: "client is not authorized to access the following products: balance",
      requestId: "req-abc123"
    });

  it("falls back to the accounts lookup balances and still pulls transactions", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      accountsBalanceGet: async () => {
        throw invalidProduct();
      },
      accountsGet: async () => ({
        institutionId: "ins_1",
        accounts: [balanceAccount({ balanceCents: 4200 })]
      }),
      transactionsSync: async () =>
        syncPage({ added: [tx({ transaction_id: "t1" })], nextCursor: "c1" })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.items).toEqual([
      { itemId: "item-1", status: "connected", added: 1, modified: 0, removed: 0, pages: 1 }
    ]);
    expect(await kv.get(NS.accounts, "acc-1")).toMatchObject({ balanceCents: 4200 });
    const chunk = await kv.get(NS.transactions, "acc-1:2026-07");
    expect((chunk as { transactions: { id: string }[] }).transactions.map((r) => r.id)).toEqual([
      "t1"
    ]);
  });

  it("still marks reauth when the balance check says login is required", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      accountsBalanceGet: async () => {
        throw new PlaidError("ITEM_LOGIN_REQUIRED", 400);
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.items).toMatchObject([{ status: "reauth-required" }]);
  });

  it("persists Plaid's full error detail on a failed item, never the token", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      transactionsSync: async () => {
        throw invalidProduct();
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    const stored = await kv.get(NS.connections, "item:item-1");
    expect(stored).toMatchObject({
      status: "error",
      lastError: "INVALID_PRODUCT",
      lastErrorDetail: {
        type: "INVALID_REQUEST",
        code: "INVALID_PRODUCT",
        message: "client is not authorized to access the following products: balance",
        requestId: "req-abc123"
      }
    });
    expect(JSON.stringify(stored)).not.toContain("access-1");
  });

  it("clears the stored error detail after a good sync", async () => {
    const kv = fakeKv();
    await kv.set(NS.connections, "item:item-1", {
      itemId: "item-1",
      institutionId: "ins_1",
      connectedAt: "2026-07-01T00:00:00Z",
      status: "error",
      lastError: "X",
      lastErrorDetail: { type: "T", code: "X", message: "m", requestId: "r" }
    });
    const { ports } = fakePorts({ kv, plaid: fakePlaid().client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    const stored = (await kv.get(NS.connections, "item:item-1")) as Record<string, unknown>;
    expect(stored.lastError).toBeUndefined();
    expect(stored.lastErrorDetail).toBeUndefined();
  });

  it("logs a metadata-only line on failure", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      transactionsSync: async () => {
        throw invalidProduct();
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a) => {
      lines.push(a.join(" "));
    });
    try {
      await syncRunHandler(ports)(ACTOR);
    } finally {
      spy.mockRestore();
    }
    const line = lines.find((l) => l.includes("INVALID_PRODUCT"));
    expect(line).toBeDefined();
    expect(line).toContain("item-1");
    expect(line).not.toContain("access-1");
  });

  it("deletes removed transactions when the batch carries only removals", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.accounts, "acc-1", { ...balanceAccount(), itemId: "item-1", updatedAt: "x" });
    await kv.set(NS.transactions, "acc-1:2026-07", {
      transactions: [
        {
          id: "pend-1",
          accountId: "acc-1",
          date: "2026-07-10",
          amountCents: 1234,
          isoCurrency: "USD",
          name: "X",
          merchant: null,
          plaidCategory: null,
          categoryId: null,
          pending: true,
          pendingTransactionId: null,
          categorizedBy: null
        }
      ]
    });
    const plaid = fakePlaid({
      transactionsSync: async () => syncPage({ removed: [{ transaction_id: "pend-1" }] })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    const chunk = (await kv.get(NS.transactions, "acc-1:2026-07")) as {
      transactions: unknown[];
    } | null;
    expect(chunk?.transactions ?? []).toEqual([]);
  });

  it("restarts from the starting cursor on mutation-during-pagination", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.connections, "cursor:item-1", { cursor: "c-start" });
    const cursorsSeen: (string | null)[] = [];
    let n = 0;
    const plaid = fakePlaid({
      transactionsSync: async (_token: string, cursor: string | null) => {
        cursorsSeen.push(cursor);
        n += 1;
        if (n === 1) {
          return syncPage({
            added: [tx({ transaction_id: "t1" })],
            nextCursor: "c-mid",
            hasMore: true
          });
        }
        if (n === 2) {
          throw new PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400);
        }
        return syncPage({ added: [tx({ transaction_id: "t1" })], nextCursor: "c-end" });
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(cursorsSeen).toEqual(["c-start", "c-mid", "c-start"]);
    expect(result.items).toMatchObject([{ status: "connected", added: 1, pages: 1 }]);
  });

  it("gives up after repeated mutation errors and records the item error", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      transactionsSync: async () => {
        throw new PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400);
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.items).toMatchObject([{ status: "error" }]);
    expect(plaid.callsTo("transactionsSync").length).toBeLessThanOrEqual(4);
  });

  it("falls back when the balance check fails on the network, not just on a Plaid error", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      accountsBalanceGet: async () => {
        throw new FinanceFetchError("fetch_failed", "network down");
      },
      transactionsSync: async () =>
        syncPage({ added: [tx({ transaction_id: "t1" })], nextCursor: "c1" })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.items).toMatchObject([{ status: "connected", added: 1 }]);
    expect(plaid.callsTo("accountsGet")).toHaveLength(1);
  });

  it("keeps the balance-check error on a connected item after falling back", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      accountsBalanceGet: async () => {
        throw invalidProduct();
      },
      transactionsSync: async () => syncPage({ nextCursor: "c1" })
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    const stored = await kv.get(NS.connections, "item:item-1");
    expect(stored).toMatchObject({
      status: "connected",
      lastErrorDetail: { code: "INVALID_PRODUCT", requestId: "req-abc123" }
    });
    expect(stored).not.toHaveProperty("lastError");
  });

  it("leaves nothing from an abandoned download after a restart", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    let n = 0;
    const plaid = fakePlaid({
      transactionsSync: async () => {
        n += 1;
        if (n === 1) {
          return syncPage({
            added: [tx({ transaction_id: "ghost" })],
            nextCursor: "c-mid",
            hasMore: true
          });
        }
        if (n === 2) throw new PlaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400);
        return syncPage({ added: [tx({ transaction_id: "real" })], nextCursor: "c-end" });
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    const chunk = await kv.get(NS.transactions, "acc-1:2026-07");
    expect((chunk as { transactions: { id: string }[] }).transactions.map((r) => r.id)).toEqual([
      "real"
    ]);
  });

  it("skips a second sync while one holds the lease", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({});
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await kv.set(NS.connections, "lock:sync", { at: ports.now().getTime() });
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.status).toBe("busy");
    expect(plaid.callsTo("transactionsSync")).toHaveLength(0);
  });

  it("keeps the pagination start on every checkpoint until the last page is applied", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    await kv.set(NS.connections, "cursor:item-1", { cursor: "c-start" });
    let n = 0;
    const plaid = fakePlaid({
      transactionsSync: async () => {
        n += 1;
        return syncPage({
          added: [tx({ transaction_id: `t${n}` })],
          nextCursor: `c${n}`,
          hasMore: n < 2
        });
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const sets: unknown[] = [];
    const realSet = ports.kv.set.bind(ports.kv);
    ports.kv.set = async (ns, key, value) => {
      if (key === "cursor:item-1") sets.push(value);
      return realSet(ns, key, value);
    };
    await syncRunHandler(ports)(ACTOR);
    expect(sets).toEqual([{ cursor: "c1", paginationStart: "c-start" }, { cursor: "c2" }]);
  });

  it("does not run when another sync took the lease first", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({});
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    const realGet = ports.kv.get.bind(ports.kv);
    ports.kv.get = async (ns, key) => {
      const value = await realGet(ns, key);
      // A rival overwrites the lease between our write and our read-back.
      if (key === "lock:sync" && value?.owner !== undefined) {
        await ports.kv.set(ns, key, { at: ports.now().getTime(), owner: "rival" });
        return { at: ports.now().getTime(), owner: "rival" };
      }
      return value;
    };
    const result = await syncRunHandler(ports)(ACTOR);
    expect(result.status).toBe("busy");
    expect(plaid.callsTo("transactionsSync")).toHaveLength(0);
  });

  it("takes the lease and releases it when done", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({ transactionsSync: async () => syncPage({ nextCursor: "c1" }) });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    expect(kv.ops.some((op) => JSON.stringify(op).includes("lock:sync"))).toBe(true);
    expect(await kv.get(NS.connections, "lock:sync")).toBeNull();
  });

  it("leaves a replacement lease alone when it finishes", async () => {
    const kv = fakeKv();
    await seedItem(kv, "item-1");
    const plaid = fakePlaid({
      transactionsSync: async () => {
        // Another owner takes over the lease while this sync is running.
        await kv.set(NS.connections, "lock:sync", { at: NOW.getTime(), owner: "other" });
        return syncPage({ nextCursor: "c1" });
      }
    });
    const { ports } = fakePorts({ kv, plaid: plaid.client, tokens: TOKENS });
    await syncRunHandler(ports)(ACTOR);
    expect(await kv.get(NS.connections, "lock:sync")).toMatchObject({ owner: "other" });
  });
});
