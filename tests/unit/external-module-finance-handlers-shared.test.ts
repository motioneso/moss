// tests/unit/external-module-finance-handlers-shared.test.ts
import { describe, expect, it } from "vitest";

import type {
  PlaidAccount,
  PlaidClient
} from "../../external-modules/finance/src/adapters/plaid.js";
import { kvStore, NS } from "../../external-modules/finance/src/domain/index.js";
import type { FinanceKv, SharedMirrorKv } from "../../external-modules/finance/src/domain/index.js";
import {
  sharedAccountPrefix,
  sharedMetaKey,
  sharedMonthKey
} from "../../external-modules/finance/src/domain/shared-pool.js";
import {
  accountSetSharedHandler,
  shareApplyHandler
} from "../../external-modules/finance/src/worker/handlers/shared.js";
import { syncRunHandler } from "../../external-modules/finance/src/worker/handlers/sync.js";
import type { TokenMap, WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";

// FIN-04 (#1149) Task 4: the share/sync worker handlers over the household
// mirror (spec delta §"Share / unshare semantics" + amendment "Host change
// 2"). Contracts pinned here:
//   - set-shared ON flips the owner's AccountRecord AND writes meta + every
//     stored month chunk to finance.shared in the SAME invocation; OFF
//     deletes the full account prefix in the same invocation;
//   - both directions are idempotent SETs (a retryLimit-1 replay converges);
//   - handlers only ever write/delete keys under their own actorUserId
//     prefix — a handler bug must never be able to touch another owner's
//     mirror entries;
//   - the queue twin reads the HOST job envelope (command fields ride in
//     params, never flat — the a6023cb7 regression);
//   - sync mirrors changed months + refreshed meta for shared accounts,
//     PRESERVES the sharedToHousehold flag across the Plaid balance
//     refresh (the raw Plaid row knows nothing about sharing), and its
//     own-prefix reconcile GCs keys for unshared/deleted accounts;
//   - secret hygiene: the share paths never read tokens/creds/settings and
//     never touch the rules/budgets namespaces.

const NOW = new Date("2026-07-18T12:00:00Z");
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

function fakeKv(): FinanceKv & { touched: Set<string> } {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const touched = new Set<string>();
  const ns = (namespace: string) => {
    touched.add(namespace);
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
    list: async (namespace) => [...ns(namespace).keys()],
    touched
  };
}

// The instance-scoped finance.shared port. Records every write/delete key so
// the own-prefix invariant can be asserted over the CALLS, not just the end
// state (a write to a foreign prefix followed by a delete would otherwise
// pass a state-only check).
function fakeMirror(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Record<string, unknown>>(
    Object.entries(seed).map(([key, value]) => [key, structuredClone(value)])
  );
  const setKeys: string[] = [];
  const deleteKeys: string[] = [];
  const mirror: SharedMirrorKv = {
    get: async (key) => structuredClone(store.get(key) ?? null),
    set: async (key, value) => {
      setKeys.push(key);
      store.set(key, structuredClone(value));
    },
    delete: async (key) => {
      deleteKeys.push(key);
      return store.delete(key);
    },
    list: async () => [...store.keys()]
  };
  return {
    mirror,
    setKeys,
    deleteKeys,
    snapshot: () =>
      Object.fromEntries([...store.entries()].map(([k, v]) => [k, structuredClone(v)]))
  };
}

// Share handlers must never need Plaid, tokens, instance creds, or settings —
// the throwing ports ARE the namespace-isolation assertion (same pattern as
// the budget handler suite).
function fakePorts(opts: {
  kv?: FinanceKv;
  mirror: SharedMirrorKv;
  plaid?: PlaidClient;
  tokens?: TokenMap;
}): WorkerPorts {
  const secretsAllowed = opts.tokens !== undefined;
  const kv = opts.kv ?? fakeKv();
  return {
    kv,
    mirror: opts.mirror,
    ai: null,
    db: null,
    plaid: opts.plaid ? () => opts.plaid! : null,
    tokens: {
      read: async () => {
        if (!secretsAllowed) throw new Error("share handlers must not read tokens");
        return opts.tokens!;
      },
      write: async () => {
        throw new Error("share/sync handlers must never write the token map");
      }
    },
    creds: {
      get: async () => {
        if (!secretsAllowed) throw new Error("share handlers must not read creds");
        return { clientId: "client-id-7f3a", secret: "secret-9b2c" };
      }
    },
    settings: {
      getEnvironment: async () => {
        if (!secretsAllowed) throw new Error("share handlers must not read settings");
        return "sandbox";
      }
    },
    isAdmin: false,
    now: () => NOW,
    // FIN-06b (#1166): pre-cutover handler tests stay on kvStore — the
    // FIN-06c cutover (Tasks 8-10) is what makes handlers actually call this.
    store: async () => kvStore(kv)
  };
}

function accountRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: "acc-1",
    itemId: "item-1",
    name: "Everyday Checking",
    officialName: "Everyday Checking Plus",
    type: "depository",
    subtype: "checking",
    mask: "4321",
    balanceCents: 254_317,
    isoCurrency: "USD",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...over
  };
}

let txnSeq = 0;
function txnRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  txnSeq += 1;
  return {
    id: `tx-${txnSeq}`,
    accountId: "acc-1",
    date: "2026-07-15",
    amountCents: 1_234,
    isoCurrency: "USD",
    name: "BLUE BOTTLE COFFEE OAK",
    merchant: "Blue Bottle",
    plaidCategory: "FOOD_AND_DRINK",
    categoryId: "dining",
    pending: false,
    pendingTransactionId: null,
    categorizedBy: "plaid-map",
    ...over
  };
}

/** Seed one owned account plus two month chunks (one with a private note). */
async function seedOwnedAccount(kv: FinanceKv) {
  await kv.set(NS.accounts, "acc-1", accountRecord());
  await kv.set(NS.transactions, "acc-1:2026-06", {
    transactions: [txnRow({ date: "2026-06-20", notes: "therapy copay — private" })]
  });
  await kv.set(NS.transactions, "acc-1:2026-07", { transactions: [txnRow()] });
  // A second, never-shared account: its chunks must not leak into the mirror.
  await kv.set(NS.accounts, "acc-2", accountRecord({ accountId: "acc-2", mask: "9999" }));
  await kv.set(NS.transactions, "acc-2:2026-07", {
    transactions: [txnRow({ accountId: "acc-2" })]
  });
}

const SHARED_META = {
  accountId: "acc-1",
  ownerUserId: OWNER,
  name: "Everyday Checking",
  officialName: "Everyday Checking Plus",
  type: "depository",
  subtype: "checking",
  mask: "4321",
  balanceCents: 254_317,
  isoCurrency: "USD",
  updatedAt: "2026-07-17T00:00:00.000Z"
};

describe("finance.account.set-shared / finance.share-apply (#1149)", () => {
  it("ON flips the record and mirrors meta + every stored month, allowlisted", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    const { mirror, snapshot } = fakeMirror();

    const result = await accountSetSharedHandler(fakePorts({ kv, mirror }))({
      actorUserId: OWNER,
      accountId: "acc-1",
      shared: true
    });

    expect(result).toEqual({ status: "ok", accountId: "acc-1", shared: true });
    const record = await kv.get(NS.accounts, "acc-1");
    expect(record?.sharedToHousehold).toBe(true);

    const state = snapshot();
    // Sorted order puts month keys before ":meta" (digit "2" < "m").
    expect(Object.keys(state).sort()).toEqual([
      sharedMonthKey(OWNER, "acc-1", "2026-06"),
      sharedMonthKey(OWNER, "acc-1", "2026-07"),
      sharedMetaKey(OWNER, "acc-1")
    ]);
    // toEqual: the meta must be exactly the allowlisted projection — itemId,
    // status, and the share flag itself must not ride along.
    expect(state[sharedMetaKey(OWNER, "acc-1")]).toEqual(SHARED_META);
    // The private note never crosses into instance scope.
    expect(JSON.stringify(state)).not.toContain("therapy copay");
    const june = state[sharedMonthKey(OWNER, "acc-1", "2026-06")] as {
      transactions: Record<string, unknown>[];
    };
    expect(june.transactions).toHaveLength(1);
    expect(june.transactions[0]).not.toHaveProperty("notes");
  });

  it("OFF deletes the full account prefix in the same invocation, nothing else", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    await kv.set(NS.accounts, "acc-1", accountRecord({ sharedToHousehold: true }));
    const foreignKey = sharedMetaKey(OTHER, "acc-9");
    const { mirror, snapshot } = fakeMirror({
      [sharedMetaKey(OWNER, "acc-1")]: SHARED_META,
      [sharedMonthKey(OWNER, "acc-1", "2026-06")]: { transactions: [] },
      [sharedMetaKey(OWNER, "acc-2")]: { ...SHARED_META, accountId: "acc-2" },
      [foreignKey]: { accountId: "acc-9", ownerUserId: OTHER }
    });

    const result = await accountSetSharedHandler(fakePorts({ kv, mirror }))({
      actorUserId: OWNER,
      accountId: "acc-1",
      shared: false
    });

    expect(result).toEqual({ status: "ok", accountId: "acc-1", shared: false });
    expect((await kv.get(NS.accounts, "acc-1"))?.sharedToHousehold).toBe(false);
    // Own acc-1 prefix gone; own acc-2 and the OTHER owner's entry untouched.
    expect(Object.keys(snapshot()).sort()).toEqual([sharedMetaKey(OWNER, "acc-2"), foreignKey]);
  });

  it("replaying either direction converges (SET semantics, retryLimit 1)", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    const { mirror, snapshot } = fakeMirror();
    const handler = accountSetSharedHandler(fakePorts({ kv, mirror }));

    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: true });
    const afterFirst = snapshot();
    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: true });
    expect(snapshot()).toEqual(afterFirst);

    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: false });
    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: false });
    expect(snapshot()).toEqual({});
  });

  it("only ever writes and deletes keys under its own actorUserId prefix", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    // Foreign entries present in the mirror while both directions run.
    const { mirror, setKeys, deleteKeys } = fakeMirror({
      [sharedMetaKey(OTHER, "acc-1")]: { accountId: "acc-1", ownerUserId: OTHER }
    });
    const handler = accountSetSharedHandler(fakePorts({ kv, mirror }));

    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: true });
    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: false });

    expect(setKeys.length).toBeGreaterThan(0);
    expect(deleteKeys.length).toBeGreaterThan(0);
    for (const key of [...setKeys, ...deleteKeys]) {
      expect(key.startsWith(`${OWNER}:`)).toBe(true);
    }
  });

  it("rejects an accountId that is not on record", async () => {
    const { mirror } = fakeMirror();
    await expect(
      accountSetSharedHandler(fakePorts({ kv: fakeKv(), mirror }))({
        actorUserId: OWNER,
        accountId: "acc-ghost",
        shared: true
      })
    ).rejects.toThrow(/accountId is not on record/);
  });

  it("queue twin reads the host envelope and rejects flat command fields", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    const { mirror, snapshot } = fakeMirror();
    const apply = shareApplyHandler(fakePorts({ kv, mirror }));

    // Foreign jobKind: fail loudly instead of acting on another queue's job.
    await expect(
      apply({
        actorUserId: OWNER,
        jobKind: "finance.budget-apply",
        idempotencyKey: "idem-0",
        params: { accountId: "acc-1", shared: true }
      })
    ).rejects.toThrow(/jobKind is not supported/);

    // Flat ids (the a6023cb7 regression shape) must not silently no-op.
    await expect(
      apply({
        actorUserId: OWNER,
        jobKind: "finance.share-apply",
        idempotencyKey: "idem-1",
        accountId: "acc-1",
        shared: true
      })
    ).rejects.toThrow(/params must be an object/);

    const result = await apply({
      actorUserId: OWNER,
      jobKind: "finance.share-apply",
      idempotencyKey: "idem-2",
      params: { accountId: "acc-1", shared: true }
    });
    expect(result).toEqual({ status: "ok", accountId: "acc-1", shared: true });
    expect(snapshot()[sharedMetaKey(OWNER, "acc-1")]).toEqual(SHARED_META);
  });

  it("never reads tokens/creds/settings and never touches rules/budgets", async () => {
    const kv = fakeKv();
    await seedOwnedAccount(kv);
    const { mirror } = fakeMirror();
    const handler = accountSetSharedHandler(fakePorts({ kv, mirror }));

    // fakePorts throws on any tokens/creds/settings access, so completing
    // both directions IS the secret-boundary proof; the touched-set pins the
    // user-scope namespaces to exactly accounts + transactions.
    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: true });
    await handler({ actorUserId: OWNER, accountId: "acc-1", shared: false });
    expect([...kv.touched].sort()).toEqual([NS.accounts, NS.transactions]);
  });
});

// --- sync integration: mirror upkeep rides the normal sync write path ------

function plaidForSync(balance: Partial<PlaidAccount> = {}): PlaidClient {
  return {
    linkTokenCreate: async () => {
      throw new Error("not used");
    },
    linkTokenGet: async () => {
      throw new Error("not used");
    },
    itemPublicTokenExchange: async () => {
      throw new Error("not used");
    },
    accountsGet: async () => {
      throw new Error("not used");
    },
    institutionGet: async () => ({ name: null }),
    accountsBalanceGet: async () => ({
      accounts: [
        {
          accountId: "acc-1",
          name: "Everyday Checking",
          officialName: "Everyday Checking Plus",
          type: "depository",
          subtype: "checking",
          mask: "4321",
          balanceCents: 777_00,
          isoCurrency: "USD",
          ...balance
        }
      ]
    }),
    transactionsSync: async () => ({
      added: [
        {
          transaction_id: "plaid-tx-new",
          account_id: "acc-1",
          date: "2026-07-16",
          amount: 12.34,
          iso_currency_code: "USD",
          name: "COFFEE SHOP",
          merchant_name: "Coffee Shop",
          personal_finance_category: { primary: "FOOD_AND_DRINK" },
          pending: false,
          pending_transaction_id: null
        }
      ],
      modified: [],
      removed: [],
      nextCursor: "c-end",
      hasMore: false
    })
  };
}

const TOKENS: TokenMap = { "item-1": { accessToken: "access-1", institutionId: "ins_1" } };

async function seedConnectedItem(kv: FinanceKv) {
  await kv.set(NS.connections, "item:item-1", {
    itemId: "item-1",
    institutionId: "ins_1",
    connectedAt: "2026-07-01T00:00:00Z",
    status: "connected"
  });
}

describe("finance.sync-run mirror upkeep (#1149)", () => {
  it("requires the host-bound actorUserId (envelope or injected tool input)", async () => {
    const { mirror } = fakeMirror();
    await expect(
      syncRunHandler(fakePorts({ kv: fakeKv(), mirror, tokens: TOKENS }))({})
    ).rejects.toThrow(/actorUserId is required/);
  });

  it("preserves the share flag across the balance refresh and mirrors meta + changed months", async () => {
    const kv = fakeKv();
    await seedConnectedItem(kv);
    // The stored record carries the share flag; the raw Plaid balance row
    // doesn't. A plain overwrite would silently unshare on every sync.
    await kv.set(NS.accounts, "acc-1", accountRecord({ sharedToHousehold: true }));
    const { mirror, snapshot } = fakeMirror();
    const ports = fakePorts({ kv, mirror, plaid: plaidForSync(), tokens: TOKENS });

    const result = (await syncRunHandler(ports)({ actorUserId: OWNER })) as { status: string };
    expect(result.status).toBe("ok");

    const record = await kv.get(NS.accounts, "acc-1");
    expect(record?.sharedToHousehold).toBe(true);
    expect(record?.balanceCents).toBe(777_00);

    const state = snapshot();
    // Meta refreshed with the new balance so viewers see fresh numbers.
    expect(state[sharedMetaKey(OWNER, "acc-1")]).toMatchObject({
      ownerUserId: OWNER,
      accountId: "acc-1",
      balanceCents: 777_00
    });
    const july = state[sharedMonthKey(OWNER, "acc-1", "2026-07")] as {
      transactions: Record<string, unknown>[];
    };
    expect(july.transactions.map((row) => row.id)).toContain("plaid-tx-new");
    for (const row of july.transactions) {
      expect(row).not.toHaveProperty("notes");
    }
  });

  it("does not mirror anything for unshared accounts", async () => {
    const kv = fakeKv();
    await seedConnectedItem(kv);
    await kv.set(NS.accounts, "acc-1", accountRecord());
    const { mirror, snapshot } = fakeMirror();

    await syncRunHandler(fakePorts({ kv, mirror, plaid: plaidForSync(), tokens: TOKENS }))({
      actorUserId: OWNER
    });
    expect(snapshot()).toEqual({});
  });

  it("own-prefix reconcile GCs unshared/deleted accounts and leaves other owners alone", async () => {
    const kv = fakeKv();
    await seedConnectedItem(kv);
    await kv.set(NS.accounts, "acc-1", accountRecord({ sharedToHousehold: true }));
    const foreignKey = sharedMetaKey(OTHER, "acc-9");
    const { mirror, snapshot } = fakeMirror({
      // Stale: this account no longer exists for OWNER.
      [sharedMetaKey(OWNER, "acc-gone")]: { accountId: "acc-gone", ownerUserId: OWNER },
      [sharedMonthKey(OWNER, "acc-gone", "2026-05")]: { transactions: [] },
      [foreignKey]: { accountId: "acc-9", ownerUserId: OTHER }
    });

    await syncRunHandler(fakePorts({ kv, mirror, plaid: plaidForSync(), tokens: TOKENS }))({
      actorUserId: OWNER
    });

    const keys = Object.keys(snapshot());
    expect(keys).not.toContain(sharedMetaKey(OWNER, "acc-gone"));
    expect(keys).not.toContain(sharedMonthKey(OWNER, "acc-gone", "2026-05"));
    expect(keys).toContain(foreignKey);
    expect(keys).toContain(sharedMetaKey(OWNER, "acc-1"));
  });

  it("reconciles even when no items remain (last disconnect leaves no orphans)", async () => {
    const kv = fakeKv();
    const { mirror, snapshot } = fakeMirror({
      [sharedMetaKey(OWNER, "acc-gone")]: { accountId: "acc-gone", ownerUserId: OWNER }
    });

    const result = await syncRunHandler(fakePorts({ kv, mirror, tokens: TOKENS }))({
      actorUserId: OWNER
    });
    expect(result).toEqual({ status: "ok", items: [] });
    expect(snapshot()).toEqual({});
  });

  it("skips reconcile keys under a prefix that merely STARTS with the actor id", async () => {
    // `${OWNER}-suffix:acc:meta` starts with OWNER but belongs to a different
    // (hypothetical) id — the prefix match must be on `${OWNER}:` exactly.
    const kv = fakeKv();
    const nearMissKey = `${OWNER}-suffix:acc-x:meta`;
    const { mirror, snapshot } = fakeMirror({
      [nearMissKey]: { accountId: "acc-x", ownerUserId: `${OWNER}-suffix` }
    });

    await syncRunHandler(fakePorts({ kv, mirror, tokens: TOKENS }))({ actorUserId: OWNER });
    expect(Object.keys(snapshot())).toContain(nearMissKey);
  });
});

// Referenced so the import stays live for the prefix helper contract check.
void sharedAccountPrefix;
